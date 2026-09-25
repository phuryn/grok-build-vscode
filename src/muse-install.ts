/** Fixed host-owned installer; no renderer input becomes shell text. */
export function museInstallCommand(platform: NodeJS.Platform): string {
  const done = "When installation finishes, click Re-check, then Connect Muse Code.";
  return platform === "win32"
    ? `irm https://dev.meta.ai/install.ps1 | iex; Write-Host "\`n${done}"`
    : `curl -fsSL https://dev.meta.ai/install.sh | bash && echo "\\n${done}"`;
}
