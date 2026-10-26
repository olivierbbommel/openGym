#!/bin/sh
# Renames upstream's iOS identifiers to the olibos ones, so this build can sit next to the App
# Store openGym on the same iPhone and Watch. Safe to run twice. After a rebase onto upstream,
# take upstream's side of any conflict in these files and run this again.
#
#   sh scripts/ios/olibos-ids.sh
#
#   ch.opengym.app[.suffix]   -> com.olibos.opengym[.suffix]   (bundle ids, BGTask id, queue labels)
#   group.ch.opengym.app      -> group.com.olibos.opengym      (App Group)
#   opengym-watch://          -> oligym-watch://               (watch URL scheme)
#   CFBundleDisplayName       -> OliGym                        (iPhone and Watch app, both widgets)
#   the complications' name   -> OliGym                        (WatchWidgets/OpenGymWidgets.swift)
set -eu
cd "$(dirname "$0")/../.."

IOS=frontend/ios
FILES="
$IOS/App/App.xcodeproj/project.pbxproj
$IOS/App/App/App.entitlements
$IOS/App/App/Info.plist
$IOS/App/App/AnimationPacksPlugin.swift
$IOS/App/App/NudgeCheckPlugin.swift
$IOS/App/App/WorkoutActivity.swift
$IOS/App/Watch/Info.plist
$IOS/App/Watch/OpenGymWatch.entitlements
$IOS/App/Watch/WidgetState.swift
$IOS/App/WatchWidgets/OpenGymWatchWidgets.entitlements
$IOS/App/WatchWidgets/OpenGymWidgets.swift
$IOS/App/OpenGymWidgets/OpenGymWidgets.entitlements
$IOS/App/AnimationPacksDownloader/AnimationPacksDownloader.entitlements
$IOS/App/AnimationPacksDownloader/Info.plist
$IOS/ci/add-asset-downloader.rb
$IOS/ci/add-ui-tests.rb
$IOS/ci/add-watch-app.rb
$IOS/ci/add-widgets.rb
scripts/ios/finish-ipa.sh
.github/workflows/ios.yml
"

for f in $FILES; do
  sed -i '' -e 's/ch\.opengym\.app/com.olibos.opengym/g' -e 's/opengym-watch/oligym-watch/g' "$f"
done

# The name the watch face and the widget gallery show (the complications say it in words).
sed -i '' -e 's/Text(verbatim: "openGym")/Text(verbatim: "OliGym")/g' -e 's/configurationDisplayName("openGym")/configurationDisplayName("OliGym")/g' \
  -e 's/description("Opens openGym\.")/description("Opens OliGym.")/g' "$IOS/App/WatchWidgets/OpenGymWidgets.swift"
sed -i '' 's/mode: "idle", title: "openGym"/mode: "idle", title: "OliGym"/' "$IOS/App/Watch/WidgetState.swift"

# The app's own title where it says its name (Home without a profile, the first launch, sign-in).
sed -i '' "s/ : 'openGym'}<\/h1>/ : 'OliGym'}<\/h1>/" frontend/src/views/Home.jsx
sed -i '' "s/margin: '10px 0 4px' }}>openGym<\/h1>/margin: '10px 0 4px' }}>OliGym<\/h1>/" frontend/src/views/Login.jsx frontend/src/views/MobileOnboarding.jsx

# Edit the line after the key in place (plutil -replace would re-sort the whole file).
for p in App Watch OpenGymWidgets WatchWidgets; do
  sed -i '' '/<key>CFBundleDisplayName<\/key>/{n;s|<string>.*</string>|<string>OliGym</string>|;}' "$IOS/App/$p/Info.plist"
done

# Anything left means upstream added a new place that names the old ids.
if git grep -n -e 'ch\.opengym\.app' -e 'opengym-watch' -- "$IOS" scripts/ios .github/workflows/ios.yml ':!scripts/ios/olibos-ids.sh'; then
  echo "olibos-ids: the lines above still name upstream's ids; add their files to FILES" >&2
  exit 1
fi
echo "olibos-ids: done"
