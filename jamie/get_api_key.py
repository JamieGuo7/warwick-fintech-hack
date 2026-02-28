import requests

r = requests.post(
    "https://apisandbox.openbankproject.com/my/logins/direct",
    # ✅ CORRECT - Should be "DirectLogin" header (no quotes around values)
    headers={
        "DirectLogin": 'username=JamieGuo,password=S$31D_GeK9Ds_,consumer_key=r1xroitz1pedtfivlhtzh5noenlqtsynbmwf2lc2'
    }
)

print(r.json())
