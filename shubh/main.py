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
    d_list, p_list, t_list, r_list = [], [], [], []
    for debt in user.debts:
        d_list.append(debt.total_amount)
        p_list.append(debt.monthly_payment)
        t_list.append(math.inf if debt.months_remaining is None else float(debt.months_remaining))
        r_list.append(debt.apr / 100 / 12)   # APR % → monthly decimal rate

    # If the user has no debts, use a single dummy zero-balance entry
    if not d_list:
        d_list, p_list, t_list, r_list = [0.0], [0.0], [math.inf], [0.0]

    # --- Adjust expenses to exclude debt payments (avoid double-counting) ---
    # The user's average_expenses is INCLUSIVE of debt payments (as entered/derived
    # from their CSV). The simulation accounts for debt payments separately via p[],
    # so we strip them out of mu_E here.
    total_monthly_debt = sum(debt.monthly_payment for debt in user.debts)
    adjusted_expenses  = max(0.0, user.average_expenses - total_monthly_debt)

    # --- Variance: use CSV-derived values if available, else ±20% heuristic ---
    if user.var_income is not None:
        var_I = user.var_income
    else:
        var_I = (user.average_income * 0.20) ** 2

    if user.var_expenses is not None:
        # Also need to adjust the expense variance: removing a fixed quantity
        # (total debt payments) from a random variable doesn't change its variance,
        # so we pass the raw CSV expense variance through unchanged.
        var_E = user.var_expenses
    else:
        var_E = (adjusted_expenses * 0.20) ** 2

    score = shield_score(
        mu_I  = user.average_income,
        mu_E  = adjusted_expenses,
        var_I = var_I,
        var_E = var_E,
        d     = d_list,
        p     = p_list,
        t     = t_list,
        r     = r_list,
        B0    = user.current_savings,
        N     = 200_000,
    )

    return {"name": user.name, "shield_score": score}