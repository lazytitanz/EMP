using EMP.Hosting;
using Xunit;

namespace EMP.Tests;

public sealed class PlaylistStoreTests : IDisposable
{
    private readonly string root;
    private readonly string filePath;

    public PlaylistStoreTests()
    {
        root = Path.Combine(Path.GetTempPath(), "EMP-playlist-store-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        filePath = Path.Combine(root, "playlists.json");
        PlaylistStore.SetFilePathForTests(filePath);
    }

    public void Dispose()
    {
        PlaylistStore.SetFilePathForTests(null);
        try
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, recursive: true);
            }
        }
        catch (Exception)
        {
            // Temp cleanup is best-effort.
        }
    }

    [Fact]
    public void Save_RefusesLowerRevisionOverwrite()
    {
        PlaylistStore.Load();
        Assert.True(PlaylistStore.SavePlaylistsJson(
            """[{"id":"pl_liked","name":"Liked Songs","kind":"liked","trackIds":["a","b"]}]""",
            revision: 2));
        Assert.Equal(2, PlaylistStore.CurrentRevision);

        Assert.False(PlaylistStore.SavePlaylistsJson(
            """[{"id":"pl_liked","name":"Liked Songs","kind":"liked","trackIds":["only"]}]""",
            revision: 1));
        Assert.Contains("\"a\"", PlaylistStore.CurrentJson, StringComparison.Ordinal);
        Assert.Equal(2, PlaylistStore.CurrentRevision);
    }

    [Fact]
    public void Save_AllowsIntentionalShrinkWithHigherRevision()
    {
        PlaylistStore.Load();
        Assert.True(PlaylistStore.SavePlaylistsJson(
            """[{"id":"mix","name":"My Mix","trackIds":["a","b","c"]}]""",
            revision: 1));
        Assert.True(PlaylistStore.SavePlaylistsJson(
            """[{"id":"mix","name":"My Mix","trackIds":["a"]}]""",
            revision: 2));
        Assert.Equal(2, PlaylistStore.CurrentRevision);
        Assert.DoesNotContain("\"b\"", PlaylistStore.CurrentJson, StringComparison.Ordinal);
    }

    [Fact]
    public void Save_AllowsEmptyOnlyWhenRevisionAdvances()
    {
        PlaylistStore.Load();
        Assert.True(PlaylistStore.SavePlaylistsJson(
            """[{"id":"mix","name":"My Mix","trackIds":["a"]}]""",
            revision: 1));
        Assert.False(PlaylistStore.SavePlaylistsJson("[]", revision: 1));
        Assert.Contains("mix", PlaylistStore.CurrentJson, StringComparison.Ordinal);

        Assert.True(PlaylistStore.SavePlaylistsJson("[]", revision: 2));
        Assert.Equal("[]", PlaylistStore.CurrentJson);
        Assert.Equal(2, PlaylistStore.CurrentRevision);
    }

    [Fact]
    public void Save_CreatesRotatingBackup()
    {
        PlaylistStore.Load();
        Assert.True(PlaylistStore.SavePlaylistsJson(
            """[{"id":"one","name":"One","trackIds":[]}]""",
            revision: 1));
        Assert.True(PlaylistStore.SavePlaylistsJson(
            """[{"id":"two","name":"Two","trackIds":[]}]""",
            revision: 2));
        Assert.True(File.Exists(filePath + ".bak.1"));
        string backup = File.ReadAllText(filePath + ".bak.1");
        Assert.Contains("one", backup, StringComparison.Ordinal);
    }

    [Fact]
    public void Load_FallsBackToBackupWhenPrimaryCorrupt()
    {
        PlaylistStore.Load();
        Assert.True(PlaylistStore.SavePlaylistsJson(
            """[{"id":"safe","name":"Safe","trackIds":["z"]}]""",
            revision: 3));
        Assert.True(PlaylistStore.SavePlaylistsJson(
            """[{"id":"newer","name":"Newer","trackIds":["y"]}]""",
            revision: 4));
        // bak.1 holds the pre-write snapshot ("safe"); primary holds "newer".
        File.WriteAllText(filePath, "{not-json");
        PlaylistStore.Load();
        Assert.Contains("safe", PlaylistStore.CurrentJson, StringComparison.Ordinal);
        Assert.Equal(3, PlaylistStore.CurrentRevision);
    }

    [Fact]
    public void DocumentCreatedAssignment_EmitsRevisionObject()
    {
        PlaylistStore.Load();
        string assignment = PlaylistStore.DocumentCreatedAssignment();
        Assert.Contains("window.__emp.playlistsBackup = {\"revision\":0,\"playlists\":[]}", assignment, StringComparison.Ordinal);
    }

    [Fact]
    public void LegacyArrayLoad_GetsRevisionOneWhenNonEmpty()
    {
        File.WriteAllText(filePath, """[{"id":"legacy","name":"Legacy","trackIds":["a"]}]""");
        PlaylistStore.Load();
        Assert.Equal(1, PlaylistStore.CurrentRevision);
        Assert.Contains("legacy", PlaylistStore.CurrentJson, StringComparison.Ordinal);
    }
}
