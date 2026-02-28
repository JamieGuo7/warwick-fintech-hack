import math
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from models import UserOnboarding
from data_store import save_user, get_user
from simulation import simulate_purchase
from scoring import shield_score

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/onboard/")
def onboard_user(user: UserOnboarding):
    save_user(user)
    return {"message": f"Onboarding complete for {user.name}", "data": user}


@app.get("/user/{name}")
def get_user_data(name: str):
    user = get_user(name)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


@app.post("/simulate/{name}")
def simulate(name: str, purchase_amount: float):
    user = get_user(name)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    result = simulate_purchase(user, purchase_amount)
    return result


@app.get("/score/{name}")
def get_score(name: str):
    user = get_user(name)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # --- Build debt parameter lists ---
    # Use math.inf for indefinite debts; convert APR % to monthly rate
    d, p, t, r = [], [], [], []
    for debt in user.debts:
        d.append(debt.total_amount)
        p.append(debt.monthly_payment)
        t.append(math.inf if debt.months_remaining is None else float(debt.months_remaining))
        r.append(debt.apr / 100 / 12)   # APR % → monthly decimal rate

    # If the user has no debts, use a single dummy zero-balance entry so
    # the simulation doesn't break on empty lists.
    if not d:
        d, p, t, r = [0.0], [0.0], [math.inf], [0.0]

    # --- Adjust expenses to exclude debt payments ---
    # The user's average_expenses figure includes their debt payments, but the
    # simulation already accounts for debt payments separately via p[]. Subtract
    # total monthly debt payments from expenses to avoid double-counting.
    total_monthly_debt = sum(debt.monthly_payment for debt in user.debts)
    adjusted_expenses = max(0.0, user.average_expenses - total_monthly_debt)

    # --- Income/expense variance: assume ±20% std dev as a sensible default ---
    # Users didn't supply variance directly, so we derive it from their income
    # and adjusted expenses. This can be made configurable in a future version.
    var_I = (user.average_income  * 0.20) ** 2
    var_E = (adjusted_expenses    * 0.20) ** 2

    score = shield_score(
        mu_I  = user.average_income,
        mu_E  = adjusted_expenses,
        var_I = var_I,
        var_E = var_E,
        d     = d,
        p     = p,
        t     = t,
        r     = r,
        B0    = user.current_savings,
        N     = 200_000,
    )

    return {"name": user.name, "shield_score": score}