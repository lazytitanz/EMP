using System.Text.Json;
using System.Text.Json.Serialization;

namespace EMP.Hosting
{
    internal sealed class ListenStatsJournalEntry
    {
        public long Seq { get; set; }

        public string SessionToken { get; set; } = string.Empty;

        public long UpdateId { get; set; }

        public string TrackId { get; set; } = string.Empty;

        public long PlayCountDelta { get; set; }

        public long ListenMsDelta { get; set; }

        public long LastPlayedAt { get; set; }

        public Dictionary<string, long> DayListenMsDelta { get; set; } = new(StringComparer.Ordinal);
    }

    internal sealed class ListenStatsJournalEnvelope
    {
        public int SchemaVersion { get; set; }

        public long NextSeq { get; set; }

        public List<ListenStatsJournalEntry> Entries { get; set; } = [];
    }

    internal static class ListenStatsJournal
    {
        public const int SchemaVersion = 1;

        private static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            WriteIndented = false
        };

        public static string FilePath => ListenStatsPaths.ListenJournalFile;

        public static ListenStatsJournalEnvelope LoadOrEmpty(out bool quarantined)
        {
            quarantined = false;
            try
            {
                if (!File.Exists(FilePath))
                {
                    return new ListenStatsJournalEnvelope { SchemaVersion = SchemaVersion, NextSeq = 1 };
                }

                string text = File.ReadAllText(FilePath);
                if (string.IsNullOrWhiteSpace(text))
                {
                    return new ListenStatsJournalEnvelope { SchemaVersion = SchemaVersion, NextSeq = 1 };
                }

                ListenStatsJournalEnvelope? envelope = JsonSerializer.Deserialize<ListenStatsJournalEnvelope>(text, JsonOptions);
                if (envelope is null || envelope.SchemaVersion != SchemaVersion)
                {
                    QuarantineExisting("unsupported-or-null");
                    quarantined = true;
                    return new ListenStatsJournalEnvelope { SchemaVersion = SchemaVersion, NextSeq = 1 };
                }

                envelope.Entries ??= [];
                envelope.NextSeq = Math.Max(1, envelope.NextSeq);
                foreach (ListenStatsJournalEntry entry in envelope.Entries)
                {
                    entry.DayListenMsDelta ??= new Dictionary<string, long>(StringComparer.Ordinal);
                }

                return envelope;
            }
            catch (Exception)
            {
                QuarantineExisting("invalid");
                quarantined = true;
                return new ListenStatsJournalEnvelope { SchemaVersion = SchemaVersion, NextSeq = 1 };
            }
        }

        public static bool TryWrite(ListenStatsJournalEnvelope envelope)
        {
            string path = FilePath;
            string temp = $"{path}.{Guid.NewGuid():N}.tmp";
            try
            {
                string? directory = Path.GetDirectoryName(path);
                if (!string.IsNullOrWhiteSpace(directory))
                {
                    Directory.CreateDirectory(directory);
                }

                envelope.SchemaVersion = SchemaVersion;
                File.WriteAllText(temp, JsonSerializer.Serialize(envelope, JsonOptions));
                File.Move(temp, path, overwrite: true);
                return true;
            }
            catch (Exception)
            {
                try
                {
                    File.Delete(temp);
                }
                catch (Exception)
                {
                    // Best-effort cleanup.
                }

                return false;
            }
        }

        private static void QuarantineExisting(string reason)
        {
            try
            {
                if (!File.Exists(FilePath))
                {
                    return;
                }

                string stamp = DateTime.Now.ToString("yyyyMMddHHmmss");
                string dest = $"{FilePath}.corrupt-{stamp}-{reason}";
                File.Move(FilePath, dest, overwrite: false);
            }
            catch (Exception)
            {
                // Preserve original bytes if rename fails; caller starts empty in memory.
            }
        }
    }
}
