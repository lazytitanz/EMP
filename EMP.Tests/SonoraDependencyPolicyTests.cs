using Xunit;

namespace EMP.Tests
{
    public sealed class SonoraDependencyPolicyTests
    {
        [Fact]
        public void EmpCsproj_DefaultsToPinnedPackageReference_NotAbsoluteProjectPath()
        {
            string repoRoot = FindRepoRoot();
            string csproj = File.ReadAllText(Path.Combine(repoRoot, "EMP", "EMP.csproj"));

            Assert.Contains("SonoraIntegrationMode", csproj, StringComparison.Ordinal);
            Assert.Contains("Package", csproj, StringComparison.Ordinal);
            Assert.Contains("Sonora.Audio.Windows", csproj, StringComparison.Ordinal);
            Assert.Contains("SonoraPackageVersion", csproj, StringComparison.Ordinal);
            Assert.DoesNotContain(@"C:\projects\Sonora", csproj, StringComparison.OrdinalIgnoreCase);
        }

        [Fact]
        public void NugetConfig_IncludesRelativeSonoraLocalFeed()
        {
            string repoRoot = FindRepoRoot();
            string nugetConfig = File.ReadAllText(Path.Combine(repoRoot, "nuget.config"));

            Assert.Contains("sonora-local", nugetConfig, StringComparison.Ordinal);
            Assert.Contains("./.sonora-packages", nugetConfig, StringComparison.Ordinal);
        }

        private static string FindRepoRoot()
        {
            DirectoryInfo? dir = new(AppContext.BaseDirectory);
            while (dir is not null)
            {
                if (File.Exists(Path.Combine(dir.FullName, "EMP.slnx"))
                    || File.Exists(Path.Combine(dir.FullName, "EMP", "EMP.csproj")))
                {
                    if (File.Exists(Path.Combine(dir.FullName, "EMP", "EMP.csproj")))
                    {
                        return dir.FullName;
                    }
                }

                dir = dir.Parent;
            }

            throw new DirectoryNotFoundException("Could not locate EMP repository root from test output.");
        }
    }
}
