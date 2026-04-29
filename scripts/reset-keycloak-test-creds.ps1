#!/usr/bin/env pwsh
# ============================================================
# Reset dev passwords for the 4 local Keycloak test users.
# Aligned to V083 5-role matrix (docs/role-permission-matrix.md).
#
# Affects (local users only — adam_ou is LDAP-federated and untouched):
#   auth_admin_test  → AUTHZ_ADMIN
#   steward_test     → DATA_STEWARD
#   tsai_bi          → BI_USER
#   etl_pipeline     → ETL_SVC
#
# Defaults match the dev Keycloak on 192.168.40.60. Override via env vars:
#   KC_URL, KC_REALM, KC_ADMIN_USER, KC_ADMIN_PASSWORD, DEV_PASSWORD
#
# Usage:
#   pwsh -File scripts/reset-keycloak-test-creds.ps1
#   $env:DEV_PASSWORD='other-pw'; pwsh -File scripts/reset-keycloak-test-creds.ps1
# ============================================================

$ErrorActionPreference = 'Stop'

$KC            = if ($env:KC_URL)            { $env:KC_URL }            else { 'http://192.168.40.60:8080' }
$REALM         = if ($env:KC_REALM)          { $env:KC_REALM }          else { 'data-nexus' }
$ADMIN_USER    = if ($env:KC_ADMIN_USER)     { $env:KC_ADMIN_USER }     else { 'admin' }
$ADMIN_PW      = if ($env:KC_ADMIN_PASSWORD) { $env:KC_ADMIN_PASSWORD } else { 'admin' }
$DEV_PASSWORD  = if ($env:DEV_PASSWORD)      { $env:DEV_PASSWORD }      else { 'phison8299' }

$tokenResp = Invoke-RestMethod -Method Post -Uri "$KC/realms/master/protocol/openid-connect/token" `
  -ContentType 'application/x-www-form-urlencoded' `
  -Body "grant_type=password&client_id=admin-cli&username=$ADMIN_USER&password=$ADMIN_PW"
$TOKEN = $tokenResp.access_token
$H     = @{ Authorization = "Bearer $TOKEN" }
$Hjson = @{ Authorization = "Bearer $TOKEN"; 'Content-Type' = 'application/json' }

$targets = @('auth_admin_test', 'steward_test', 'tsai_bi', 'etl_pipeline')

Write-Output "Resetting passwords on realm '$REALM' at $KC"
foreach ($name in $targets) {
  $u = Invoke-RestMethod -Method Get -Uri "$KC/admin/realms/$REALM/users?username=$name&exact=true" -Headers $H
  if ($u.Count -eq 0) {
    Write-Output ('  ' + $name + '  (not found — skip)')
    continue
  }
  $uid = $u[0].id
  $pwBody = @{ type='password'; value=$DEV_PASSWORD; temporary=$false } | ConvertTo-Json -Compress
  Invoke-RestMethod -Method Put -Uri "$KC/admin/realms/$REALM/users/$uid/reset-password" -Headers $Hjson -Body $pwBody | Out-Null
  Write-Output ('  ' + $name + '  password reset')
}
Write-Output 'Done.'
