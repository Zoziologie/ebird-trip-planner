"""Read-only cloud usage report. Uses the administrator's existing gcloud login."""
import calendar
import datetime as dt
import json
import subprocess
import urllib.parse
import urllib.request

project = "ebird-trip-planner"
token = subprocess.run(["gcloud", "auth", "print-access-token"], capture_output=True, text=True, check=True).stdout.strip()
headers = {"Authorization": "Bearer " + token, "x-goog-user-project": project}


def pages(url, key):
    items = []
    while True:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=45) as response:
            page = json.load(response)
        items.extend(page.get(key, []))
        if not page.get("nextPageToken"):
            return items
        url = url.split("?")[0] + "?pageToken=" + urllib.parse.quote(page["nextPageToken"], safe="")


def documents(collection):
    return [{"id": item["name"].rsplit("/", 1)[1], **{name: next(iter(value.values())) for name, value in item.get("fields", {}).items()}}
            for item in pages(f"https://firestore.googleapis.com/v1/projects/{project}/databases/(default)/documents/{collection}", "documents")]


trips = documents("cloudTrips")
accounts = documents("cloudAccounts")
objects = pages(f"https://storage.googleapis.com/storage/v1/b/{project}.firebasestorage.app/o", "items")
now = dt.datetime.now(dt.timezone.utc)
month = now.year * 12 + now.month - 1 - 6
year, month = divmod(month, 12)
cutoff = now.replace(year=year, month=month + 1, day=min(now.day, calendar.monthrange(year, month + 1)[1]))
published = [trip for trip in trips if trip.get("revision")]
print(f"Cloud usage report — {now.date()} UTC")
print(f"Owners with saved trips: {len({trip['ownerUid'] for trip in published})}; published trips: {len(published)}; public trips: {sum(trip.get('public', False) for trip in published)}")
print(f"Published archives: {sum(int(trip.get('size', 0)) for trip in published) / 1024**2:.1f} MiB")
print(f"All live bucket objects: {len(objects)}; live storage: {sum(int(item['size']) for item in objects) / 1024**2:.1f} MiB (excludes soft-deleted data)")
print(f"Accounts with custom allowances: {len(accounts)}")
print("Trips inactive for more than six months (review only; nothing deleted):")
for trip in published:
    active = trip.get("lastActiveAt", trip["updatedAt"])
    if dt.datetime.fromisoformat(active.replace("Z", "+00:00")) < cutoff:
        print(json.dumps({"id": trip["id"], "name": trip["name"], "lastActiveAt": active}))
print("Billing is separate: check Cloud Billing Reports for charges, downloads and retained deleted archives.")
