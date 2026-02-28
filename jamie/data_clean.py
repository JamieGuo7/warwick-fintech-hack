import pandas as pd
import json
import os

# 1. Load the file
filename = 'all_transactions.json'
with open(filename, 'r') as f:
    data = json.load(f)

# 2. Create a "suitable directory" for your exports
output_dir = 'data'
if not os.path.exists(output_dir):
    os.makedirs(output_dir)
    print(f"Created directory: {output_dir}")

# 3. Loop through each Account in the JSON
# (Your file has one, but this handles multiple if they exist!)
for account_id, account_data in data.items():

    # Sanitize the account_id to make it a safe filename (remove slashes)
    safe_filename = account_id.replace('/', '_').replace('.', '_')

    transactions_list = account_data.get('transactions', [])
    rows = []

    for tx in transactions_list:
        raw_date = tx['details']['posted']

        rows.append({
            "Transaction_ID": tx['id'],
            "Date": raw_date.split('T')[0],
            "Time": raw_date.split('T')[1].replace('Z', ''),
            "Description": tx['details'].get('description'),
            "Amount": float(tx['details']['value'].get('amount', 0)),
            "Currency": tx['details']['value'].get('currency'),
            "Balance": tx['details']['new_balance'].get('amount'),
            "Recipient": tx['other_account']['holder'].get('name')
        })

    # 4. Create the DataFrame for THIS account
    df = pd.DataFrame(rows)

    # 5. Save to the directory
    file_path = os.path.join(output_dir, f"account_{safe_filename}.csv")
    df.to_csv(file_path, index=False)

    print(f"✅ Saved {len(df)} transactions to: {file_path}")

# 6. Global Pandas Settings for your console view
pd.set_option('display.max_columns', None)
pd.set_option('display.expand_frame_repr', False)
print("\n--- PREVIEW OF LAST EXPORT ---")
print(df.head())