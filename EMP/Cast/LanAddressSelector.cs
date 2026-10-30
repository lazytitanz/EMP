using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace EMP.Cast
{
    internal static class LanAddressSelector
    {
        public static IPAddress? ForDevice(IPAddress? deviceAddress)
        {
            List<UnicastIPAddressInformation> candidates = EnumerateIpv4().ToList();
            if (candidates.Count == 0)
            {
                return null;
            }

            if (deviceAddress is not null && deviceAddress.AddressFamily == AddressFamily.InterNetwork)
            {
                UnicastIPAddressInformation? match = candidates.FirstOrDefault(item =>
                    item.IPv4Mask is not null
                    && SameSubnet(item.Address, item.IPv4Mask, deviceAddress));
                if (match is not null)
                {
                    return match.Address;
                }
            }

            return candidates[0].Address;
        }

        public static IReadOnlyList<IPAddress> LocalIpv4Addresses()
        {
            return EnumerateIpv4().Select(item => item.Address).ToArray();
        }

        private static IEnumerable<UnicastIPAddressInformation> EnumerateIpv4()
        {
            NetworkInterface[] nics;
            try
            {
                nics = NetworkInterface.GetAllNetworkInterfaces();
            }
            catch (Exception)
            {
                yield break;
            }

            foreach (NetworkInterface nic in nics)
            {
                if (nic.OperationalStatus != OperationalStatus.Up
                    || nic.NetworkInterfaceType is NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel)
                {
                    continue;
                }

                IPInterfaceProperties properties;
                try
                {
                    properties = nic.GetIPProperties();
                }
                catch (Exception)
                {
                    continue;
                }

                foreach (UnicastIPAddressInformation address in properties.UnicastAddresses)
                {
                    if (address.Address.AddressFamily != AddressFamily.InterNetwork
                        || IPAddress.IsLoopback(address.Address)
                        || IsLinkLocal(address.Address))
                    {
                        continue;
                    }

                    yield return address;
                }
            }
        }

        private static bool SameSubnet(IPAddress local, IPAddress mask, IPAddress remote)
        {
            byte[] localBytes = local.GetAddressBytes();
            byte[] maskBytes = mask.GetAddressBytes();
            byte[] remoteBytes = remote.GetAddressBytes();
            if (localBytes.Length != 4 || maskBytes.Length != 4 || remoteBytes.Length != 4)
            {
                return false;
            }

            for (int i = 0; i < 4; i++)
            {
                if ((localBytes[i] & maskBytes[i]) != (remoteBytes[i] & maskBytes[i]))
                {
                    return false;
                }
            }

            return true;
        }

        private static bool IsLinkLocal(IPAddress address)
        {
            byte[] bytes = address.GetAddressBytes();
            return bytes.Length == 4 && bytes[0] == 169 && bytes[1] == 254;
        }
    }
}
