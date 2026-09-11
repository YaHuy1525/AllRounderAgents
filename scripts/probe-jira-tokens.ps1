# One-off probe: test every JIRA API token present in .env (active + commented).
$ErrorActionPreference = "Continue"
$lines = Get-Content "d:\Code\AllRounderAgent\.env" | Where-Object { $_ -match 'JIRA_API_TOKEN=' }
$index = 0
foreach ($line in $lines) {
  $index++
  $active = -not $line.TrimStart().StartsWith("#")
  $token = (($line -split 'JIRA_API_TOKEN=', 2)[1]).Trim()
  $myself = curl.exe -s -o NUL -w "%{http_code}" -u "louis@omnidewalt.com:$token" "https://omnidewalt.atlassian.net/rest/api/3/myself"
  $board = curl.exe -s -o NUL -w "%{http_code}" -u "louis@omnidewalt.com:$token" "https://omnidewalt.atlassian.net/rest/agile/1.0/board"
  $search = curl.exe -s -G -u "louis@omnidewalt.com:$token" "https://omnidewalt.atlassian.net/rest/api/3/search/jql" --data-urlencode 'jql=project = "SCRUM"' --data-urlencode "maxResults=2" -w " HTTP:%{http_code}"
  Write-Output ("token #$index (active=$active) len=$($token.Length): myself=$myself board=$board search=$search")
}
