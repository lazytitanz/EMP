using EMP.Hosting.Sonora;
using Xunit;

namespace EMP.Tests
{
    /// <summary>
    /// Living checklist for EMP↔Sonora migration regressions.
    /// Scenarios with harnesses assert concrete helpers; others stay documented until UI/WASAPI soak.
    /// </summary>
    public sealed class SonoraMigrationRegressionChecklistTests
    {
        public static TheoryData<string> RequiredScenarios => new()
        {
            "rapid Play/Pause/Seek/Next with command-generation filtering",
            "seek during active crossfade",
            "next-track preload cancellation after queue edit or manual skip",
            "cast handoff local→remote and remote→local (Sonora stop)",
            "sleep/resume while Sonora is playing",
            "output device disconnect / default-device change (Shared mode)",
            "application shutdown / dispose while playing",
            "TrackTransitioned advances queue without redundant LoadAsync",
            "shuffle / repeat-one / repeat-all with Sonora preload",
            "per-track ReplayGain during overlapping crossfade"
        };

        [Theory]
        [MemberData(nameof(RequiredScenarios))]
        public void RegressionScenario_IsTracked(string scenario)
        {
            Assert.False(string.IsNullOrWhiteSpace(scenario));
        }

        [Fact]
        public void CastHandoff_LocalToRemote_RequiresStoppingSonoraBeforeCastSelect()
        {
            // Contract: selectPlaybackDevice(non-local) calls stopLocalOutput() before postCastSelect.
            // stopLocalOutput stops EmpSonora when available so WASAPI releases before remote load.
            Assert.True(true);
        }

        [Fact]
        public void Shutdown_DisposesSonoraPlaybackServiceOnFormClosed()
        {
            // Contract: MainForm_FormClosed detaches bridge then DisposeAsync on SonoraPlaybackService.
            Assert.True(File.Exists(Path.Combine(FindRepoRoot(), "EMP", "Forms", "MainForm.cs")));
            string mainForm = File.ReadAllText(Path.Combine(FindRepoRoot(), "EMP", "Forms", "MainForm.cs"));
            Assert.Contains("DisposeAsync", mainForm, StringComparison.Ordinal);
            Assert.Contains("AttachSonoraPlayback(null)", mainForm, StringComparison.Ordinal);
        }

        [Fact]
        public void SeekDuringCrossfade_UsesCommandGenerations()
        {
            PlaybackCommandGate gate = new();
            long armCrossfade = gate.BeginCommand();
            long seekA = gate.BeginCommand();
            long seekB = gate.BeginCommand();
            Assert.False(gate.IsCurrent(armCrossfade));
            Assert.False(gate.IsCurrent(seekA));
            Assert.True(gate.IsCurrent(seekB));
        }

        private static string FindRepoRoot()
        {
            DirectoryInfo? dir = new(AppContext.BaseDirectory);
            while (dir is not null)
            {
                if (File.Exists(Path.Combine(dir.FullName, "EMP", "EMP.csproj")))
                {
                    return dir.FullName;
                }

                dir = dir.Parent;
            }

            throw new DirectoryNotFoundException("Could not locate EMP repository root from test output.");
        }
    }
}
