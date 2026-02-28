# Simple in-memory storage for hackathon
user_data_store = {}

def save_user(user):
    user_data_store[user.name] = user

def get_user(name):
    return user_data_store.get(name)