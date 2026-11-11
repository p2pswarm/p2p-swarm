# p2p-swarm installer for Windows.
#
#   irm https://p2pswarm.github.io/p2p-swarm/install.ps1 | iex
#
# Downloads the release from GitHub, checks it against the published SHA-256,
# and installs it for the current user. No administrator rights needed.
#
#   $env:P2P_SWARM_VERSION = '0.3.0'   install a specific version (default: latest)
#   $env:P2P_SWARM_INSTALL = '<dir>'   where it goes (default: %LOCALAPPDATA%\p2p-swarm)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Install-P2PSwarm {
  $repo = 'p2pswarm/p2p-swarm'
  $archive = 'p2p-swarm-win-x64.zip'
  if ($env:P2P_SWARM_BASE_URL) { $base = $env:P2P_SWARM_BASE_URL }
  elseif ($env:P2P_SWARM_VERSION) { $base = "https://github.com/$repo/releases/download/v$($env:P2P_SWARM_VERSION.TrimStart('v'))" }
  else { $base = "https://github.com/$repo/releases/latest/download" }
  $dest = if ($env:P2P_SWARM_INSTALL) { $env:P2P_SWARM_INSTALL } else { Join-Path $env:LOCALAPPDATA 'p2p-swarm' }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("p2p-swarm-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    Write-Host "Downloading p2p-swarm for Windows..."
    foreach ($name in @($archive, 'SHA256SUMS')) {
      $out = Join-Path $tmp $name
      # A local folder is accepted as the source so the installer can be tested offline.
      if (Test-Path -LiteralPath $base) { Copy-Item -LiteralPath (Join-Path $base $name) -Destination $out }
      else { Invoke-WebRequest -UseBasicParsing -Uri "$base/$name" -OutFile $out }
    }

    $line = Get-Content (Join-Path $tmp 'SHA256SUMS') | Where-Object { $_ -match "\s$([regex]::Escape($archive))$" } | Select-Object -First 1
    if (-not $line) { throw "no checksum published for $archive" }
    $expected = ($line -split '\s+')[0].ToLower()
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $tmp $archive)).Hash.ToLower()
    if ($expected -ne $actual) { throw "checksum mismatch for $archive (expected $expected, got $actual)" }

    # Windows' built-in tar unpacks thousands of small files far faster than Expand-Archive.
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (Test-Path $tar) {
      & $tar -xf (Join-Path $tmp $archive) -C $tmp
      if ($LASTEXITCODE -ne 0) { throw "could not unpack $archive" }
    } else {
      Expand-Archive -LiteralPath (Join-Path $tmp $archive) -DestinationPath $tmp -Force
    }
    $new = Join-Path $tmp 'p2p-swarm'
    if (-not (Test-Path (Join-Path $new 'swarm.cmd'))) { throw "$archive did not contain the expected files" }
    $null = & (Join-Path $new 'swarm.cmd') help 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'the downloaded build does not run on this machine' }
    $version = (Get-Content (Join-Path $new 'VERSION') | Select-Object -First 1).Trim()

    # Replace any previous install, stopping its background node first. Swarm
    # data lives in %USERPROFILE%\.p2p-swarm and is untouched.
    if (Test-Path (Join-Path $dest 'swarm.cmd')) {
      try { $null = & (Join-Path $dest 'swarm.cmd') stop 2>&1 } catch { }
      Remove-Item -LiteralPath $dest -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    Move-Item -LiteralPath $new -Destination $dest

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (($userPath -split ';') -contains $dest)) {
      [Environment]::SetEnvironmentVariable('Path', (($userPath, $dest) -ne '' -join ';'), 'User')
      $env:Path = "$env:Path;$dest"
      $pathNote = 'Open a new terminal for the `swarm` command to be found.'
    }

    Write-Host ""
    Write-Host "p2p-swarm $version installed: $dest\swarm.cmd"
    if ($pathNote) { Write-Host $pathNote }
    Write-Host ""
    Write-Host "Next:"
    Write-Host "  swarm create my-swarm      create a swarm and print its link"
    Write-Host "  swarm ui                   open the dashboard"
    Write-Host "  swarm agent <link>         lend this machine's Claude to a swarm"
    Write-Host ""
    Write-Host "Use it from inside Claude Code:"
    Write-Host "  claude mcp add --scope user swarm -- `"$dest\swarm.cmd`" mcp"
  }
  finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

try {
  Install-P2PSwarm
} catch {
  Write-Host "install failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host $_.ScriptStackTrace
  exit 1
}
