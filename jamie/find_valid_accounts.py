import requests
import json

# Your credentials
base_url = "https://apisandbox.openbankproject.com"
username = "JamieGuo"
password = "S$31D_GeK9Ds_"
consumer_key = "r1xroitz1pedtfivlhtzh5noenlqtsynbmwf2lc2"


TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyIiOiIifQ.XMrvCF84VIMAvXAjkXhW17dFWNOZbrMJPL_BIlYmfqM"
BASE = "https://apisandbox.openbankproject.com/obp/v5.1.0"
HEADERS = {"Authorization": f'DirectLogin token="{TOKEN}"'}


# Get token
auth_response = requests.post(
    f"{base_url}/my/logins/direct",
    json={
        "username": username,
        "password": password,
        "consumer_key": consumer_key
    }
)


# Get all public accounts
response = requests.get(f"{base_url}/obp/v5.1.0/accounts/public")
accounts = response.json()["accounts"]

print("Testing accounts for transaction data...\n")
print("=" * 80)

working_accounts = []

for account in accounts:
    bank_id = account["bank_id"]
    account_id = account["id"]
    label = account.get("label", "No Label")
    views = account["views_available"]

    # Skip accounts with no public views
    if not views:
        continue

    # Try the first available view
    view_id = views[0]["id"]

    print(f"\n🏦 Bank: {bank_id}")
    print(f"   Account: {account_id} ({label})")
    print(f"   View: {view_id}")

    try:
        tx_response = requests.get(
            f"{base_url}/obp/v5.1.0/banks/{bank_id}/accounts/{account_id}/{view_id}/transactions",
            headers=HEADERS,
            timeout=10
        )

        if tx_response.status_code == 200:
            data = tx_response.json()
            tx_count = len(data.get("transactions", []))

            if tx_count > 0:
                print(f"   ✅ SUCCESS! {tx_count} transactions found")
                working_accounts.append({
                    "bank_id": bank_id,
                    "account_id": account_id,
                    "label": label,
                    "view_id": view_id,
                    "transaction_count": tx_count
                })

                # Print first transaction as sample
                first_tx = data["transactions"][0]
                print(
                    f"   📝 Sample: {first_tx['details']['value']['amount']} {first_tx['details']['value']['currency']}")
                print(f"      Description: {first_tx['details'].get('description', 'N/A')}")
            else:
                print(f"   ⚠️  No transactions (empty account)")

        elif tx_response.status_code == 400:
            print(f"   ❌ Error 400 (likely corrupted data)")
        elif tx_response.status_code == 401:
            print(f"   🔒 Auth error (may need different permissions)")
        else:
            print(f"   ❌ Error {tx_response.status_code}")

    except Exception as e:
        print(f"   💥 Exception: {str(e)[:50]}")

print("\n" + "=" * 80)
print(f"\n🎯 SUMMARY: Found {len(working_accounts)} working accounts with transactions:\n")

for acc in working_accounts:
    print(f"✅ {acc['bank_id']} / {acc['account_id']} / {acc['view_id']}")
    print(f"   Label: {acc['label']}")
    print(f"   Transactions: {acc['transaction_count']}\n")

# Save working accounts to a file
with open("working_test_accounts.json", "w") as f:
    json.dump(working_accounts, f, indent=2)

print("💾 Saved working accounts to 'working_test_accounts.json")