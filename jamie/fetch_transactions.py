import requests
import json

# Configuration
BASE_URL = "https://apisandbox.openbankproject.com"

USERNAME = "JamieGuo"
PASSWORD = "S$31D_GeK9Ds_"
CONSUMER_KEY = "r1xroitz1pedtfivlhtzh5noenlqtsynbmwf2lc2"
TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyIiOiIifQ.XMrvCF84VIMAvXAjkXhW17dFWNOZbrMJPL_BIlYmfqM"

# All test accounts
TEST_ACCOUNTS = [
    {"bank_id": "gh.29.it", "account_id": "92ddfdc7-c803-4d38-ac01-651c2e9a7bc3", "view_id": "_test"},
    {"bank_id": "rbs", "account_id": "rbs-sara", "view_id": "__mob-spouse-view"},
    {"bank_id": "obp-banky-m", "account_id": "123571113171923", "view_id": "_test"},
    {"bank_id": "test-bank", "account_id": "fgarcia_account1", "view_id": "_test"},
    {"bank_id": "obp-bank-x-r", "account_id": "222", "view_id": "_test"},
    {"bank_id": "rbs", "account_id": "19840424", "view_id": "_fabi"},
    {"bank_id": "rbs", "account_id": "APA4", "view_id": "_apa4_rbs_v1"},
    {"bank_id": "chase", "account_id": "BANK-0804", "view_id": "_merchant"},
    {"bank_id": "gh.29.fi", "account_id": "456002", "view_id": "_accountant"},
    {"bank_id": "gh.29.uk", "account_id": "1234567888", "view_id": "__raju"},
    {"bank_id": "rbs", "account_id": "5566778", "view_id": "_test"},
    {"bank_id": "testowy_bank_id", "account_id": "98766", "view_id": "_test"},
    {"bank_id": "obp-bankx-n", "account_id": "ACCOUNT_ID_AS", "view_id": "_test"},
    {"bank_id": "rbs", "account_id": "savings-kids-john", "view_id": "__public"},
]


def get_direct_login_token():
    url = f"{BASE_URL}/my/logins/direct"
    headers = {
        "Content-Type": "application/json",
        "DirectLogin": f"username={USERNAME},password={PASSWORD},consumer_key={CONSUMER_KEY}"
    }
    response = requests.post(url, headers=headers)
    if response.status_code == 201:
        return response.json()['token']
    raise Exception(f"Login failed: {response.text}")


def get_transactions(token, bank_id, account_id, view_id):
    url = f"{BASE_URL}/obp/v5.1.0/banks/{bank_id}/accounts/{account_id}/{view_id}/transactions"
    headers = {
        "Authorization": f"DirectLogin token={token}",
        "Content-Type": "application/json"
    }
    response = requests.get(url, headers=headers)
    if response.status_code == 200:
        return response.json()
    return None  # Silently skip accounts we can't access


def fetch_all_transactions(token):
    all_results = {}
    total_fetched = 0
    failed = []

    for account in TEST_ACCOUNTS:
        bank_id = account["bank_id"]
        account_id = account["account_id"]
        view_id = account["view_id"]
        key = f"{bank_id}/{account_id}"

        print(f"Fetching {key} (view: {view_id})...", end=" ")

        data = get_transactions(token, bank_id, account_id, view_id)

        if data and "transactions" in data:
            count = len(data["transactions"])
            all_results[key] = data
            total_fetched += count
            print(f"{count} transactions")
        else:
            failed.append(key)
            print("Failed or no access")

    return all_results, total_fetched, failed


if __name__ == "__main__":
    try:

        all_results, total_fetched, failed = fetch_all_transactions(TOKEN)

        print(f"  Accounts fetched: {len(all_results)}/{len(TEST_ACCOUNTS)}")
        print(f"  Total transactions: {total_fetched}")

        if failed:
            print(f"\nCould not access {len(failed)} account(s):")
            for f in failed:
                print(f"    - {f}")

        # Save all results
        with open("all_transactions.json", "w") as f:
            json.dump(all_results, f, indent=2)
        print(f"\nSaved to all_transactions.json")

    except Exception as e:
        print(f"Error: {e}")