# One-off probe: raw Jira responses for the configured credentials.
$ErrorActionPreference = "Continue"
$line = Get-Content "d:\Code\AllRounderAgent\.env" | Where-Object { $_ -match '^JIRA_API_TOKEN=' } | Select-Object -Last 1
$token = ($line -split '=', 2)[1]

Write-Output "=== myself RAW ==="
curl.exe -s -u "louis@omnidewalt.com:$token" "https://omnidewalt.atlassian.net/rest/api/3/myself" -w "`nHTTP:%{http_code}`n"
Write-Output "=== search/jql RAW ==="
curl.exe -s -G -u "louis@omnidewalt.com:$token" "https://omnidewalt.atlassian.net/rest/api/3/search/jql" --data-urlencode 'jql=project = "SCRUM"' --data-urlencode "maxResults=3" --data-urlencode "fields=key,summary" -w "`nHTTP:%{http_code}`n"
Write-Output "=== agile board RAW ==="
curl.exe -s -G -u "louis@omnidewalt.com:$token" "https://omnidewalt.atlassian.net/rest/agile/1.0/board" --data-urlencode "projectKeyOrId=SCRUM" -w "`nHTTP:%{http_code}`n"
