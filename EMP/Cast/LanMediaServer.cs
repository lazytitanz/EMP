using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text;
using EMP.Hosting;
using EMP.Library;

namespace EMP.Cast
{
    internal sealed class LanMediaServer : IDisposable
    {
        private const int TokenLength = 32;
        private const int HeaderLimit = 16 * 1024;
        private const int CopyBufferSize = 64 * 1024;

        private readonly object gate = new();
        private readonly Dictionary<string, MediaGrant> grants = new(StringComparer.OrdinalIgnoreCase);
        private TcpListener? listener;
        private CancellationTokenSource? lifetime;
        private Task? acceptLoop;
        private int port;
        private bool disposed;

        public int Port
        {
            get
            {
                lock (gate)
                {
                    return port;
                }
            }
        }

        public bool IsRunning
        {
            get
            {
                lock (gate)
                {
                    return listener is not null;
                }
            }
        }

        public void Start()
        {
            lock (gate)
            {
                ObjectDisposedException.ThrowIf(disposed, this);
                if (listener is not null)
                {
                    return;
                }

                TcpListener started = new(IPAddress.Any, 0);
                started.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
                started.Start();
                port = ((IPEndPoint)started.LocalEndpoint).Port;
                listener = started;
                lifetime = new CancellationTokenSource();
                acceptLoop = Task.Run(() => AcceptLoopAsync(started, lifetime.Token));
            }
        }

        public async Task StopAsync()
        {
            TcpListener? stopping;
            CancellationTokenSource? stoppingLife;
            Task? loop;
            lock (gate)
            {
                stopping = listener;
                stoppingLife = lifetime;
                loop = acceptLoop;
                listener = null;
                lifetime = null;
                acceptLoop = null;
                port = 0;
                grants.Clear();
            }

            if (stoppingLife is not null)
            {
                await stoppingLife.CancelAsync();
            }

            try
            {
                stopping?.Stop();
            }
            catch (Exception)
            {
                // Listener may already be closed.
            }

            if (loop is not null)
            {
                try
                {
                    await loop.WaitAsync(TimeSpan.FromSeconds(2));
                }
                catch (Exception)
                {
                    // Shutdown must not hang.
                }
            }

            stoppingLife?.Dispose();
        }

        public void Permit(string? currentTrackId, string? nextTrackId)
        {
            lock (gate)
            {
                ObjectDisposedException.ThrowIf(disposed, this);
                grants.Clear();
                PermitLocked(currentTrackId);
                if (!string.Equals(currentTrackId, nextTrackId, StringComparison.OrdinalIgnoreCase))
                {
                    PermitLocked(nextTrackId);
                }
            }

            LibraryMediaIndex.Retain(new[] { currentTrackId, nextTrackId }.Where(id => !string.IsNullOrWhiteSpace(id))!);
        }

        public string? MediaUrl(IPAddress? deviceAddress, string trackId)
        {
            lock (gate)
            {
                if (listener is null || port == 0)
                {
                    return null;
                }

                MediaGrant? grant = grants.Values.FirstOrDefault(item =>
                    string.Equals(item.TrackId, trackId, StringComparison.OrdinalIgnoreCase));
                if (grant is null)
                {
                    return null;
                }

                IPAddress? host = LanAddressSelector.ForDevice(deviceAddress);
                if (host is null)
                {
                    return null;
                }

                return $"http://{host}:{port}/m/{grant.MediaToken}";
            }
        }

        public string? ArtworkUrl(IPAddress? deviceAddress, string trackId)
        {
            lock (gate)
            {
                if (listener is null || port == 0)
                {
                    return null;
                }

                MediaGrant? grant = grants.Values.FirstOrDefault(item =>
                    string.Equals(item.TrackId, trackId, StringComparison.OrdinalIgnoreCase));
                if (grant?.ArtworkToken is null)
                {
                    return null;
                }

                IPAddress? host = LanAddressSelector.ForDevice(deviceAddress);
                if (host is null)
                {
                    return null;
                }

                return $"http://{host}:{port}/a/{grant.ArtworkToken}";
            }
        }

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }

            disposed = true;
            StopAsync().GetAwaiter().GetResult();
        }

        private void PermitLocked(string? trackId)
        {
            if (string.IsNullOrWhiteSpace(trackId) || !LibraryMediaIndex.TryGet(trackId, out LibraryMediaLocation location))
            {
                return;
            }

            MediaGrant grant = new()
            {
                TrackId = trackId,
                MediaToken = CreateToken(),
                ArtworkToken = string.IsNullOrWhiteSpace(location.ArtworkPath) ? null : CreateToken()
            };
            grants[grant.MediaToken] = grant;
            if (grant.ArtworkToken is not null)
            {
                grants[grant.ArtworkToken] = grant;
            }
        }

        private async Task AcceptLoopAsync(TcpListener started, CancellationToken cancellationToken)
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                TcpClient client;
                try
                {
                    client = await started.AcceptTcpClientAsync(cancellationToken);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
                catch (ObjectDisposedException)
                {
                    return;
                }
                catch (SocketException)
                {
                    if (cancellationToken.IsCancellationRequested)
                    {
                        return;
                    }

                    continue;
                }

                _ = Task.Run(() => HandleClientAsync(client, cancellationToken), cancellationToken);
            }
        }

        private async Task HandleClientAsync(TcpClient client, CancellationToken cancellationToken)
        {
            using TcpClient held = client;
            try
            {
                held.NoDelay = true;
                await using NetworkStream stream = held.GetStream();
                stream.ReadTimeout = 15000;
                stream.WriteTimeout = 15000;
                using CancellationTokenSource linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                linked.CancelAfter(TimeSpan.FromSeconds(30));
                await ServeAsync(stream, linked.Token);
            }
            catch (Exception)
            {
                // Drop the connection; local playback does not depend on this server.
            }
        }

        private async Task ServeAsync(NetworkStream stream, CancellationToken cancellationToken)
        {
            HttpRequest? request = await ReadRequestAsync(stream, cancellationToken);
            if (request is null)
            {
                await WriteStatusAsync(stream, 400, "Bad Request", cancellationToken);
                return;
            }

            if (request.Method is not "GET" and not "HEAD")
            {
                await WriteStatusAsync(stream, 405, "Method Not Allowed", cancellationToken);
                return;
            }

            if (!TryResolve(request.Path, out string? kind, out MediaGrant? grant)
                || grant is null
                || kind is null)
            {
                await WriteStatusAsync(stream, 404, "Not Found", cancellationToken);
                return;
            }

            if (!LibraryMediaIndex.TryGet(grant.TrackId, out LibraryMediaLocation location))
            {
                await WriteStatusAsync(stream, 404, "Not Found", cancellationToken);
                return;
            }

            string? filePath = kind == "a" ? location.ArtworkPath : location.FullPath;
            if (string.IsNullOrWhiteSpace(filePath)
                || !IsSafeMediaPath(filePath, grant.TrackId)
                || !File.Exists(filePath))
            {
                await WriteStatusAsync(stream, 404, "Not Found", cancellationToken);
                return;
            }

            FileInfo info = new(filePath);
            long length = info.Length;
            string contentType = MediaTypes.FromPath(filePath);
            bool head = request.Method == "HEAD";

            if (string.IsNullOrWhiteSpace(request.Range))
            {
                await WriteFileAsync(stream, filePath, contentType, 0, length, length, 200, "OK", head, cancellationToken);
                return;
            }

            if (!TryParseSingleRange(request.Range, length, out long start, out long end, out bool unsatisfiable))
            {
                await WriteFileAsync(stream, filePath, contentType, 0, length, length, 200, "OK", head, cancellationToken);
                return;
            }

            if (unsatisfiable)
            {
                await WriteRangeNotSatisfiableAsync(stream, length, cancellationToken);
                return;
            }

            long count = end - start + 1;
            await WriteFileAsync(stream, filePath, contentType, start, count, length, 206, "Partial Content", head, cancellationToken);
        }

        private bool TryResolve(string path, out string? kind, out MediaGrant? grant)
        {
            kind = null;
            grant = null;
            string[] parts = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length != 2)
            {
                return false;
            }

            kind = parts[0];
            string token = parts[1];
            if (kind is not "m" and not "a"
                || token.Length != TokenLength
                || token.Any(ch => !Uri.IsHexDigit(ch)))
            {
                kind = null;
                return false;
            }

            lock (gate)
            {
                if (!grants.TryGetValue(token, out grant))
                {
                    return false;
                }

                if (kind == "a" && !string.Equals(grant.ArtworkToken, token, StringComparison.OrdinalIgnoreCase))
                {
                    grant = null;
                    return false;
                }

                if (kind == "m" && !string.Equals(grant.MediaToken, token, StringComparison.OrdinalIgnoreCase))
                {
                    grant = null;
                    return false;
                }
            }

            return true;
        }

        private static bool IsSafeMediaPath(string filePath, string trackId)
        {
            string? full;
            try
            {
                full = Path.GetFullPath(filePath);
            }
            catch (Exception)
            {
                return false;
            }

            if (full.Contains("..", StringComparison.Ordinal))
            {
                return false;
            }

            if (LibraryMediaIndex.IsRetained(trackId))
            {
                return true;
            }

            IReadOnlyList<string> folders = AppSettingsStore.ResolvedMusicFolders();
            foreach (string folder in folders)
            {
                string? root = MusicFolderPaths.TryNormalize(folder);
                if (root is null)
                {
                    continue;
                }

                if (MusicFolderPaths.EqualsPath(root, full) || MusicFolderPaths.IsStrictParent(root, full))
                {
                    return true;
                }
            }

            string artworkRoot = Path.GetFullPath(Path.Combine(WebUiHost.WwwRootPath, "artwork"));
            return full.StartsWith(artworkRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
        }

        private static async Task<HttpRequest?> ReadRequestAsync(NetworkStream stream, CancellationToken cancellationToken)
        {
            MemoryStream buffer = new();
            byte[] chunk = new byte[1024];
            while (buffer.Length < HeaderLimit)
            {
                int read = await stream.ReadAsync(chunk.AsMemory(0, chunk.Length), cancellationToken);
                if (read <= 0)
                {
                    return null;
                }

                buffer.Write(chunk, 0, read);
                byte[] data = buffer.ToArray();
                int headerEnd = IndexOfHeaderEnd(data);
                if (headerEnd < 0)
                {
                    continue;
                }

                string text = Encoding.ASCII.GetString(data, 0, headerEnd);
                string[] lines = text.Split("\r\n", StringSplitOptions.None);
                if (lines.Length == 0)
                {
                    return null;
                }

                string[] requestLine = lines[0].Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (requestLine.Length < 2)
                {
                    return null;
                }

                string range = string.Empty;
                foreach (string line in lines.Skip(1))
                {
                    int colon = line.IndexOf(':');
                    if (colon <= 0)
                    {
                        continue;
                    }

                    string name = line[..colon].Trim();
                    if (name.Equals("Range", StringComparison.OrdinalIgnoreCase))
                    {
                        range = line[(colon + 1)..].Trim();
                    }
                }

                string path = requestLine[1];
                int query = path.IndexOf('?', StringComparison.Ordinal);
                if (query >= 0)
                {
                    path = path[..query];
                }

                return new HttpRequest(requestLine[0].ToUpperInvariant(), path, range);
            }

            return null;
        }

        private static int IndexOfHeaderEnd(byte[] data)
        {
            for (int i = 0; i + 3 < data.Length; i++)
            {
                if (data[i] == 13 && data[i + 1] == 10 && data[i + 2] == 13 && data[i + 3] == 10)
                {
                    return i;
                }
            }

            return -1;
        }

        private static bool TryParseSingleRange(string header, long length, out long start, out long end, out bool unsatisfiable)
        {
            start = 0;
            end = Math.Max(0, length - 1);
            unsatisfiable = false;
            if (length <= 0)
            {
                unsatisfiable = true;
                return true;
            }

            const string prefix = "bytes=";
            if (!header.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            string spec = header[prefix.Length..].Trim();
            if (spec.Contains(',', StringComparison.Ordinal))
            {
                return false;
            }

            int dash = spec.IndexOf('-');
            if (dash < 0)
            {
                return false;
            }

            string left = spec[..dash].Trim();
            string right = spec[(dash + 1)..].Trim();
            try
            {
                if (left.Length == 0)
                {
                    if (!long.TryParse(right, NumberStyles.None, CultureInfo.InvariantCulture, out long suffix)
                        || suffix <= 0)
                    {
                        unsatisfiable = true;
                        return true;
                    }

                    start = Math.Max(0, length - suffix);
                    end = length - 1;
                    return true;
                }

                start = long.Parse(left, NumberStyles.None, CultureInfo.InvariantCulture);
                end = right.Length == 0
                    ? length - 1
                    : long.Parse(right, NumberStyles.None, CultureInfo.InvariantCulture);
            }
            catch (Exception)
            {
                unsatisfiable = true;
                return true;
            }

            if (start < 0 || start >= length || end < start)
            {
                unsatisfiable = true;
                return true;
            }

            if (end >= length)
            {
                end = length - 1;
            }

            return true;
        }

        private static async Task WriteFileAsync(
            NetworkStream stream,
            string path,
            string contentType,
            long start,
            long count,
            long total,
            int status,
            string reason,
            bool head,
            CancellationToken cancellationToken)
        {
            StringBuilder headers = new();
            headers.Append(CultureInfo.InvariantCulture, $"HTTP/1.1 {status} {reason}\r\n");
            headers.Append(CultureInfo.InvariantCulture, $"Content-Type: {contentType}\r\n");
            headers.Append("Accept-Ranges: bytes\r\n");
            headers.Append(CultureInfo.InvariantCulture, $"Content-Length: {count}\r\n");
            if (status == 206)
            {
                long end = start + count - 1;
                headers.Append(CultureInfo.InvariantCulture, $"Content-Range: bytes {start}-{end}/{total}\r\n");
            }

            headers.Append("Connection: close\r\n\r\n");
            byte[] headerBytes = Encoding.ASCII.GetBytes(headers.ToString());
            await stream.WriteAsync(headerBytes, cancellationToken);
            if (head || count <= 0)
            {
                await stream.FlushAsync(cancellationToken);
                return;
            }

            await using FileStream file = new(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete,
                CopyBufferSize,
                FileOptions.SequentialScan | FileOptions.Asynchronous);
            file.Seek(start, SeekOrigin.Begin);
            byte[] buffer = new byte[CopyBufferSize];
            long remaining = count;
            while (remaining > 0)
            {
                int toRead = (int)Math.Min(buffer.Length, remaining);
                int read = await file.ReadAsync(buffer.AsMemory(0, toRead), cancellationToken);
                if (read <= 0)
                {
                    break;
                }

                await stream.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
                remaining -= read;
            }

            await stream.FlushAsync(cancellationToken);
        }

        private static async Task WriteRangeNotSatisfiableAsync(NetworkStream stream, long total, CancellationToken cancellationToken)
        {
            string body = string.Empty;
            string headers =
                "HTTP/1.1 416 Range Not Satisfiable\r\n" +
                "Content-Type: text/plain\r\n" +
                "Accept-Ranges: bytes\r\n" +
                $"Content-Range: bytes */{total}\r\n" +
                "Content-Length: 0\r\n" +
                "Connection: close\r\n\r\n";
            await stream.WriteAsync(Encoding.ASCII.GetBytes(headers + body), cancellationToken);
            await stream.FlushAsync(cancellationToken);
        }

        private static async Task WriteStatusAsync(NetworkStream stream, int status, string reason, CancellationToken cancellationToken)
        {
            string headers =
                $"HTTP/1.1 {status} {reason}\r\n" +
                "Content-Length: 0\r\n" +
                "Connection: close\r\n\r\n";
            await stream.WriteAsync(Encoding.ASCII.GetBytes(headers), cancellationToken);
            await stream.FlushAsync(cancellationToken);
        }

        private static string CreateToken()
        {
            return Guid.NewGuid().ToString("N");
        }

        private sealed class MediaGrant
        {
            public required string TrackId { get; init; }

            public required string MediaToken { get; init; }

            public string? ArtworkToken { get; init; }
        }

        private sealed record HttpRequest(string Method, string Path, string Range);
    }
}
