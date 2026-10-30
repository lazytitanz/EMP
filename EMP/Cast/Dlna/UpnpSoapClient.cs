using System.Diagnostics;
using System.Net;
using System.Text;
using System.Xml.Linq;

namespace EMP.Cast.Dlna
{
    internal static class DlnaLog
    {
        public static void Write(string message)
        {
            Debug.WriteLine("EMP DLNA: " + message);
        }
    }

    internal static class UpnpSoapClient
    {
        private static readonly HttpClient Http = CreateClient();
        private static readonly HttpMethod SubscribeMethod = new("SUBSCRIBE");
        private static readonly HttpMethod UnsubscribeMethod = new("UNSUBSCRIBE");

        public static async Task<XDocument?> InvokeAsync(
            Uri controlUrl,
            string serviceType,
            string action,
            IReadOnlyDictionary<string, string> arguments,
            CancellationToken cancellationToken)
        {
            (XDocument? document, _) = await InvokeRawAsync(
                controlUrl,
                serviceType,
                action,
                arguments,
                cancellationToken);
            return document;
        }

        public static async Task<(XDocument? Document, string Xml)> InvokeRawAsync(
            Uri controlUrl,
            string serviceType,
            string action,
            IReadOnlyDictionary<string, string> arguments,
            CancellationToken cancellationToken)
        {
            StringBuilder body = new();
            body.Append("""<?xml version="1.0" encoding="utf-8"?>""");
            body.Append("""<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">""");
            body.Append("<s:Body>");
            body.Append(System.Globalization.CultureInfo.InvariantCulture, $"<u:{action} xmlns:u=\"{serviceType}\">");
            foreach ((string name, string value) in arguments)
            {
                body.Append(System.Globalization.CultureInfo.InvariantCulture, $"<{name}>{System.Security.SecurityElement.Escape(value) ?? string.Empty}</{name}>");
            }

            body.Append(System.Globalization.CultureInfo.InvariantCulture, $"</u:{action}></s:Body></s:Envelope>");

            using HttpRequestMessage request = new(HttpMethod.Post, controlUrl);
            request.Headers.TryAddWithoutValidation("SOAPACTION", $"\"{serviceType}#{action}\"");
            request.Content = new StringContent(body.ToString(), Encoding.UTF8, "text/xml");
            using HttpResponseMessage response = await Http.SendAsync(request, cancellationToken);
            string xml = await response.Content.ReadAsStringAsync(cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                throw new InvalidOperationException($"UPnP {action} failed ({(int)response.StatusCode}).");
            }

            return (XDocument.Parse(xml), xml);
        }

        public static async Task<XDocument?> GetXmlAsync(Uri uri, CancellationToken cancellationToken)
        {
            using HttpResponseMessage response = await Http.GetAsync(uri, cancellationToken);
            response.EnsureSuccessStatusCode();
            string xml = await response.Content.ReadAsStringAsync(cancellationToken);
            return XDocument.Parse(xml);
        }

        public static async Task<(string Sid, TimeSpan Timeout)?> SubscribeAsync(
            Uri eventUrl,
            Uri callbackUrl,
            CancellationToken cancellationToken)
        {
            using HttpRequestMessage request = new(SubscribeMethod, eventUrl);
            request.Headers.TryAddWithoutValidation("NT", "upnp:event");
            request.Headers.TryAddWithoutValidation("CALLBACK", $"<{callbackUrl.AbsoluteUri}>");
            request.Headers.TryAddWithoutValidation("TIMEOUT", "Second-300");
            using HttpResponseMessage response = await Http.SendAsync(request, cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                DlnaLog.Write($"SUBSCRIBE failed ({(int)response.StatusCode}) {eventUrl}");
                return null;
            }

            string? sid = Header(response, "SID");
            if (string.IsNullOrWhiteSpace(sid))
            {
                DlnaLog.Write("SUBSCRIBE succeeded without SID.");
                return null;
            }

            return (sid, ParseTimeout(Header(response, "TIMEOUT")));
        }

        public static async Task RenewAsync(Uri eventUrl, string sid, CancellationToken cancellationToken)
        {
            using HttpRequestMessage request = new(SubscribeMethod, eventUrl);
            request.Headers.TryAddWithoutValidation("SID", sid);
            request.Headers.TryAddWithoutValidation("TIMEOUT", "Second-300");
            using HttpResponseMessage response = await Http.SendAsync(request, cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                throw new InvalidOperationException($"GENA renew failed ({(int)response.StatusCode}).");
            }
        }

        public static async Task UnsubscribeAsync(Uri eventUrl, string sid, CancellationToken cancellationToken)
        {
            using HttpRequestMessage request = new(UnsubscribeMethod, eventUrl);
            request.Headers.TryAddWithoutValidation("SID", sid);
            using HttpResponseMessage response = await Http.SendAsync(request, cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                DlnaLog.Write($"UNSUBSCRIBE failed ({(int)response.StatusCode})");
            }
        }

        public static string? ChildValue(XDocument? document, string localName)
        {
            return document?.Descendants().FirstOrDefault(node => node.Name.LocalName == localName)?.Value;
        }

        public static string AttributeOrValue(XElement? element)
        {
            if (element is null)
            {
                return string.Empty;
            }

            string? val = element.Attribute("val")?.Value ?? element.Attribute("Val")?.Value;
            return string.IsNullOrWhiteSpace(val) ? element.Value.Trim() : val.Trim();
        }

        private static string? Header(HttpResponseMessage response, string name)
        {
            if (response.Headers.TryGetValues(name, out IEnumerable<string>? values))
            {
                return values.FirstOrDefault();
            }

            return null;
        }

        private static TimeSpan ParseTimeout(string? value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return TimeSpan.FromSeconds(300);
            }

            int dash = value.LastIndexOf('-');
            string number = dash >= 0 ? value[(dash + 1)..] : value;
            return int.TryParse(number, out int seconds) && seconds > 0
                ? TimeSpan.FromSeconds(seconds)
                : TimeSpan.FromSeconds(300);
        }

        private static HttpClient CreateClient()
        {
            HttpClient client = new(new SocketsHttpHandler
            {
                AutomaticDecompression = DecompressionMethods.All,
                ConnectTimeout = TimeSpan.FromSeconds(5)
            });
            client.Timeout = TimeSpan.FromSeconds(8);
            client.DefaultRequestHeaders.UserAgent.ParseAdd("EMP/1.0");
            return client;
        }
    }
}
