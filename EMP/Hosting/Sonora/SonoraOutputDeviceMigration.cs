namespace EMP.Hosting.Sonora
{
    /// <summary>
    /// Maps persisted EMP audio-output selections onto WASAPI endpoint ids.
    /// Chromium sink ids are never valid for Sonora and must be migrated or cleared.
    /// </summary>
    internal static class SonoraOutputDeviceMigration
    {
        public readonly record struct Device(string Id, string Name);

        public readonly record struct Result(string DeviceId, string DeviceLabel, bool Changed);

        /// <summary>
        /// Prefer exact id match; otherwise migrate once by case-insensitive label; otherwise clear.
        /// Empty saved id means System Default.
        /// </summary>
        public static Result Resolve(
            string? savedDeviceId,
            string? savedDeviceLabel,
            IReadOnlyList<Device> activeDevices)
        {
            ArgumentNullException.ThrowIfNull(activeDevices);

            string id = savedDeviceId?.Trim() ?? string.Empty;
            string label = savedDeviceLabel?.Trim() ?? string.Empty;

            if (id.Length == 0)
            {
                return new Result(string.Empty, string.Empty, false);
            }

            foreach (Device device in activeDevices)
            {
                if (string.Equals(device.Id, id, StringComparison.OrdinalIgnoreCase))
                {
                    string resolvedLabel = string.IsNullOrWhiteSpace(device.Name) ? label : device.Name.Trim();
                    bool changed = !string.Equals(resolvedLabel, label, StringComparison.Ordinal);
                    return new Result(device.Id, resolvedLabel, changed);
                }
            }

            if (label.Length > 0)
            {
                foreach (Device device in activeDevices)
                {
                    string deviceName = device.Name?.Trim() ?? string.Empty;
                    if (deviceName.Length > 0
                        && string.Equals(deviceName, label, StringComparison.OrdinalIgnoreCase))
                    {
                        return new Result(device.Id, deviceName, true);
                    }
                }
            }

            // Stale Chromium (or removed) endpoint — fall back to system default.
            return new Result(string.Empty, string.Empty, true);
        }
    }
}
