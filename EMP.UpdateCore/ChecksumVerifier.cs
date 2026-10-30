using System.Security.Cryptography;
using System.Text;

namespace EMP.UpdateCore;

public static class ChecksumVerifier
{
    public static async Task<string> ComputeSha256HexAsync(string filePath, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(filePath);
        await using FileStream stream = File.OpenRead(filePath);
        byte[] hash = await SHA256.HashDataAsync(stream, cancellationToken).ConfigureAwait(false);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    public static string ParseSha256File(string contents, string expectedFileName)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(contents);
        ArgumentException.ThrowIfNullOrWhiteSpace(expectedFileName);

        foreach (string rawLine in contents.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries))
        {
            string line = rawLine.Trim();
            if (line.Length == 0 || line.StartsWith('#'))
            {
                continue;
            }

            string[] parts = line.Split((char[]?)null, 2, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0)
            {
                continue;
            }

            string hex = parts[0].Trim().ToLowerInvariant();
            if (hex.Length != 64 || hex.Any(static c => c is (< '0' or > '9') and (< 'a' or > 'f')))
            {
                continue;
            }

            if (parts.Length == 1)
            {
                return hex;
            }

            string name = parts[1].Trim();
            if (name.StartsWith('*'))
            {
                name = name[1..].Trim();
            }

            if (string.Equals(Path.GetFileName(name), expectedFileName, StringComparison.OrdinalIgnoreCase)
                || string.Equals(name, expectedFileName, StringComparison.OrdinalIgnoreCase))
            {
                return hex;
            }
        }

        throw new UpdateVerificationException($"Checksum file does not contain an entry for '{expectedFileName}'.");
    }

    public static async Task VerifyFileAsync(
        string filePath,
        string expectedSha256Hex,
        string? githubDigestSha256,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(filePath);
        ArgumentException.ThrowIfNullOrWhiteSpace(expectedSha256Hex);

        string actual = await ComputeSha256HexAsync(filePath, cancellationToken).ConfigureAwait(false);
        if (!FixedTimeEqualsHex(actual, expectedSha256Hex))
        {
            throw new UpdateVerificationException("SHA-256 checksum mismatch for downloaded package.");
        }

        if (!string.IsNullOrWhiteSpace(githubDigestSha256)
            && !FixedTimeEqualsHex(actual, githubDigestSha256))
        {
            throw new UpdateVerificationException("GitHub asset digest mismatch for downloaded package.");
        }
    }

    private static bool FixedTimeEqualsHex(string left, string right)
    {
        byte[] leftBytes = Encoding.ASCII.GetBytes(left.Trim().ToLowerInvariant());
        byte[] rightBytes = Encoding.ASCII.GetBytes(right.Trim().ToLowerInvariant());
        return leftBytes.Length == rightBytes.Length
            && CryptographicOperations.FixedTimeEquals(leftBytes, rightBytes);
    }
}
