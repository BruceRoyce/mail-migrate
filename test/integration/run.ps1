$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
  docker compose up --build --force-recreate -d
  if ($LASTEXITCODE -ne 0) { throw 'Disposable IMAP servers did not start' }
  New-Item -ItemType Directory -Force private-certs | Out-Null
  docker compose cp source:/etc/dovecot/test.pem private-certs/source.pem
  docker compose cp destination:/etc/dovecot/test.pem private-certs/destination.pem
  $env:IMAP_INTEGRATION = '1'
  Push-Location ../..
  try { npm run integration; if ($LASTEXITCODE -ne 0) { throw 'Integration tests failed' } }
  finally { Pop-Location }
} finally {
  Remove-Item Env:IMAP_INTEGRATION -ErrorAction SilentlyContinue
  docker compose down --volumes
  Pop-Location
}
