# One-off probe: verify the configured Jira credentials against the live site.
$ErrorActionPreference = "Continue"
$envFile = "d:\Code\AllRounderAgent\.env"
$line = Get-Content $envFile | Where-Object { $_ -match '^JIRA_API_TOKEN=' } | Select-Object -Last 1
$token = ($line -split '=', 2)[1]
Write-Output ("token found: " + [bool]$token + " length " + $token.Length)

Write-Output "=== GET /rest/api/3/myself ==="
$out = curl.exe -s -u "louis@omnidewalt.com:$token" "https://omnidewalt.atlassian.net/rest/api/3/myself" -w "`nHTTP:%{http_code}"
$out | Select-String -Pattern "HTTP:", "displayName", "accountId", "errorMessages" | ForEach-Object { $_.Line }

Write-Output "=== GET /rest/api/3/search/jql (SCRUM) ==="
$out2 = curl.exe -s -G -u "louis@omnidewalt.com:$token" "https://omnidewalt.atlassian.net/rest/api/3/search/jql" --data-urlencode 'jql=project = "SCRUM"' --data-urlencode "maxResults=3" --data-urlencode "fields=summary,status" -w "`nHTTP:%{http_code}"
$out2 | Select-String -Pattern "HTTP:", '"total"', '"key"', "errorMessages", "errors" | ForEach-Object { $_.Line }

Write-Output "=== GET /rest/agile/1.0/board?projectKeyOrId=SCRUM ==="
$out3 = curl.exe -s -G -u "louis@omnidewalt.com:$token" "https://omnidewalt.atlassian.net/rest/agile/1.0/board" --data-urlencode "projectKeyOrId=SCRUM" --data-urlencode "maxResults=50" -w "`nHTTP:%{http_code}"
$out3 | Select-String -Pattern "HTTP:", '"id"', '"name"', "errorMessages" | ForEach-Object { $_.Line }
