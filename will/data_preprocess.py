#!/usr/bin/env python3
"""
BNPL / Klarna Readiness Model — Parameter Builder (ONE-FILE SCRIPT)
===================================================================

PURPOSE
-------
Takes a transaction dictionary produced by your friend's CSV transformer
and outputs the statistical parameters needed by the Normal-distribution
credit-risk model:

    mu_I, sigma_I²   — mean and variance of monthly income
    mu_E, sigma_E²   — mean and variance of monthly essential spend
                       (everything EXCEPT identified debt/loan repayments)
    D_current        — total monthly debt/commitment repayments going forward
    loan_rates       — 1-D array of APR% for each active loan/debt

MODEL CONTEXT
-------------
You later use these parameters in:

    S = I - E - D
    I ~ Normal(mu_I, sigma_I²)
    E ~ Normal(mu_E, sigma_E²)

    mu_S  = mu_I - mu_E - D_current
    sig_S = sqrt(sigma_I² + sigma_E²)
    PD    = Phi((-B - mu_S) / sig_S)

INPUT FORMAT (friend transformer dict)
--------------------------------------
Your friend's transformer reads a CSV with columns:
    date | time | amount | currency | balance | recipient

and produces a dict like:
    {
        "transactions": [
            {
                "date":      "2024-03-15",
                "time":      "14:32:00",
                "amount":    -49.99,        # negative = money out, positive = money in
                "currency":  "GBP",
                "balance":   1203.45,
                "recipient": "Klarna"
            },
            ...
        ]
    }

Pass that dict directly to build_params_interactive(transaction_dict).

TESTING WITHOUT YOUR FRIEND
---------------------------
Run directly with a CSV:
    python bnpl_param_builder.py test_transactions.csv
"""

import csv
import math
import sys
from datetime import date, datetime, timedelta
from collections import defaultdict


# ============================================================
# CONFIGURATION
# ============================================================

MIN_REPEATS          = 3     # Min occurrences to consider something recurring
AMOUNT_CV_THRESHOLD  = 0.15  # Max coefficient of variation for amount stability
AMOUNT_STD_FLOOR     = 3.0   # Accept anyway if raw std is below this (GBP)
INTERVAL_JITTER      = 6     # Allowed day-deviation from cadence target
LOOKBACK_DAYS        = 365   # Rolling window for recurring detection (~12 months)
HALF_LIFE_MONTHS     = 4     # Recency weighting decay for mu/sigma estimation


# ============================================================
# MERCHANT BLOCKLISTS / KEYWORDS
# ============================================================

# Merchants that will never be flagged as recurring commitments even if they
# pass the statistical tests. Covers supermarkets, food, retail, transport —
# things people buy regularly but that are clearly not debt repayments.
MERCHANT_BLOCKLIST = {
    "tesco", "sainsbury", "sainsburys", "asda", "morrisons", "lidl", "aldi",
    "waitrose", "co-op", "coop", "marks & spencer", "m&s food", "iceland",
    "ocado", "amazon fresh",
    "mcdonald", "mcdonalds", "greggs", "starbucks", "costa", "pret",
    "subway", "kfc", "burger king", "domino", "pizza hut", "nando",
    "wagamama", "itsu",
    "amazon", "ebay", "argos", "boots", "primark", "tkmaxx", "tk maxx",
    "john lewis", "next", "h&m", "zara", "asos", "very",
    "bp", "shell", "esso", "texaco", "jet2", "easyjet", "trainline",
    "tfl", "transport for london", "uber", "lyft", "bolt",
    "wetherspoon", "jd wetherspoon", "greene king",
    "just eat", "uber eats", "deliveroo",
}

# Keyword sets used to pre-classify merchants before showing them to the user.
# If a merchant matches BNPL or DEBT keywords we pre-answer "is this a loan?"
# as yes and skip straight to the loan-specific questions.
BNPL_KEYWORDS = {
    "klarna", "clearpay", "laybuy", "zilch", "afterpay",
    "affirm", "monzo flex", "paypal credit", "payday",
}

DEBT_KEYWORDS = {
    "loan", "finance", "mortgage", "repayment", "hire purchase",
    "barclayloan", "halifax loan", "natwest loan", "credit",
}


# ============================================================
# CSV -> dict helper (for standalone testing)
# ============================================================

def csv_to_transaction_dict(csv_path: str) -> dict:
    """
    Reads a CSV with header: date,time,amount,currency,balance,recipient
    Returns: {"transactions": [{date, time, amount, currency, balance, recipient}, ...]}

    Used only when running this file directly for testing.
    In production your friend passes the dict in directly.
    """
    out = {"transactions": []}

    with open(csv_path, "r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if not row or not row.get("date"):
                continue

            amt_raw = (row.get("amount") or "").strip()
            if not amt_raw:
                continue
            try:
                amount = float(amt_raw)
            except ValueError:
                continue

            bal_raw = (row.get("balance") or "").strip()
            try:
                balance = float(bal_raw) if bal_raw else 0.0
            except ValueError:
                balance = 0.0

            out["transactions"].append({
                "date":      (row.get("date")      or "").strip(),
                "time":      (row.get("time")      or "").strip(),
                "amount":    amount,
                "currency":  (row.get("currency")  or "GBP").strip(),
                "balance":   balance,
                "recipient": (row.get("recipient") or "Unknown").strip(),
            })

    return out


# ============================================================
# STEP 1 — INGEST
# ============================================================

def load_transactions(data: dict) -> list[dict]:
    """
    Parses the transaction dict into a clean internal format.

    We only need three fields from your friend's dict:
        "date"      — ISO date string e.g. "2024-03-15"
        "amount"    — float, negative = outgoing, positive = income
        "recipient" — the merchant / payee name

    Everything else (time, currency, balance) is ignored.
    Skips any row missing date or amount.
    """
    raw  = data.get("transactions", [])
    txns = []

    for t in raw:
        try:
            date_str = t.get("date")
            if date_str is None:
                continue

            txn_date = datetime.fromisoformat(
                str(date_str).replace("Z", "")
            ).date()

            amount_raw = t.get("amount")
            if amount_raw is None:
                continue
            amount = float(amount_raw)

            merchant = str(t.get("recipient") or "Unknown").strip()

            txns.append({"date": txn_date, "amount": amount, "merchant": merchant})

        except Exception:
            continue  # skip malformed rows silently

    return txns


# ============================================================
# STEP 2 — RECURRING DETECTION
# ============================================================

def _month_key(d: date) -> str:
    """Sortable 'YYYY-MM' string for grouping by calendar month."""
    return f"{d.year}-{d.month:02d}"


def _is_blocklisted(merchant: str) -> bool:
    """True if merchant name contains any blocklisted term (case-insensitive)."""
    name_lower = merchant.lower()
    return any(b in name_lower for b in MERCHANT_BLOCKLIST)


def _looks_like_loan(merchant: str) -> bool:
    """
    True if the merchant name matches known BNPL or debt keywords.
    Used to pre-answer the 'is this a loan?' question for obvious cases
    so the user just confirms rather than types from scratch.
    """
    name_lower = merchant.lower()
    return any(k in name_lower for k in BNPL_KEYWORDS | DEBT_KEYWORDS)


def detect_recurring(txns: list[dict]) -> list[dict]:
    """
    Scans transaction history and returns candidate recurring payments.

    A payment qualifies only if ALL of the following hold:
      1. Outgoing (amount < 0)
      2. Within the lookback window (default: last 12 months)
      3. Merchant not on the blocklist
      4. Appears across >= 3 distinct calendar months
      5. Doesn't appear > 2 times in most months (rejects shopping habits)
      6. Amount is stable: low coefficient of variation
      7. Gaps between payments match a weekly/fortnightly/monthly cadence
         with >= 60% of gaps fitting the pattern

    Returns list of candidates sorted by confidence (highest first):
    {
        "merchant":    str,
        "amount":      float,   # mean absolute amount per occurrence
        "frequency":   str,     # "weekly" | "fortnightly" | "monthly"
        "confidence":  float,   # 0.0 – 1.0
        "months_seen": int,
        "n_txns":      int,
        "likely_loan": bool,    # True if name matches BNPL/debt keywords
    }
    """
    if not txns:
        return []

    today  = max(t["date"] for t in txns)
    cutoff = today - timedelta(days=LOOKBACK_DAYS)

    outgoing = [t for t in txns if t["amount"] < 0 and t["date"] >= cutoff]

    groups: dict[str, list] = defaultdict(list)
    for t in outgoing:
        groups[t["merchant"]].append(t)

    candidates = []

    for merchant, items in groups.items():

        if _is_blocklisted(merchant):
            continue

        if len(items) < MIN_REPEATS:
            continue

        items = sorted(items, key=lambda x: x["date"])

        # Must span >= 3 distinct calendar months
        months          = [_month_key(x["date"]) for x in items]
        distinct_months = sorted(set(months))
        if len(distinct_months) < 3:
            continue

        # Reject if it appears > 2 times in most months (shopping pattern)
        per_month: dict[str, int] = defaultdict(int)
        for m in months:
            per_month[m] += 1
        if sum(1 for c in per_month.values() if c > 2) / len(per_month) > 0.2:
            continue

        # Amount stability
        amounts  = [abs(x["amount"]) for x in items]
        mean_amt = sum(amounts) / len(amounts)
        if mean_amt < 5:
            continue

        variance = sum((a - mean_amt) ** 2 for a in amounts) / len(amounts)
        std      = math.sqrt(variance)
        cv       = std / mean_amt if mean_amt > 0 else 999.0

        if cv > AMOUNT_CV_THRESHOLD and std > AMOUNT_STD_FLOOR:
            continue

        # Cadence check
        gaps = [(items[i]["date"] - items[i-1]["date"]).days for i in range(1, len(items))]

        def cadence_score(target: int) -> float:
            return sum(1 for g in gaps if abs(g - target) <= INTERVAL_JITTER) / len(gaps)

        score_w = cadence_score(7)
        score_f = cadence_score(14)
        score_m = max(cadence_score(28), cadence_score(30), cadence_score(31))
        best    = max(score_w, score_f, score_m)

        if best < 0.6:
            continue

        frequency = (
            "weekly"      if best == score_w else
            "fortnightly" if best == score_f else
            "monthly"
        )

        likely_loan = _looks_like_loan(merchant)

        # Confidence: blend of cadence fit (60%) and amount stability (40%)
        # Small boost for known loan/BNPL keywords
        confidence = 0.6 * best + 0.4 * max(0.0, 1 - cv / 0.2)
        if likely_loan:
            confidence = min(1.0, confidence + 0.15)

        candidates.append({
            "merchant":    merchant,
            "amount":      round(mean_amt, 2),
            "frequency":   frequency,
            "confidence":  round(confidence, 2),
            "months_seen": len(distinct_months),
            "n_txns":      len(items),
            "likely_loan": likely_loan,
        })

    candidates.sort(key=lambda x: x["confidence"], reverse=True)
    return candidates


# ============================================================
# STEP 3 — MONTHLY NORMALISATION
# ============================================================

def to_monthly_amount(amount: float, frequency: str) -> float:
    """Converts a per-occurrence amount to monthly equivalent."""
    return amount * {"weekly": 52/12, "fortnightly": 26/12, "monthly": 1.0}.get(frequency, 1.0)


# ============================================================
# STEP 4 — INTERACTIVE CONFIRMATION
# ============================================================

def confirm_commitments_cli(candidates: list[dict]) -> list[dict]:
    """
    Shows each detected recurring payment and asks two things only:

      QUESTION 1 — Is this a loan / debt repayment?  (y/n)

        If NO  → it's treated as normal recurring spend, included in E
                 (essential spend), no further questions asked.

        If YES → three follow-up questions:
          Q2. Still active going forward?      (y/n)
              If no: did it stop recently?     (y/n)
          Q3. When does it end?
              Enter months remaining, or press Enter for indefinite
              (e.g. credit card, ongoing BNPL)
          Q4. APR %
              Enter rate, or press Enter to skip (defaults to 0%)

    Payments marked as loans and ACTIVE feed into D_current and loan_rates.
    Payments marked as loans but INACTIVE contribute 0 to D_current —
    this is the fix for paid-off loans biasing the model.

    Payments not marked as loans are simply left in the outflow total
    and captured naturally in mu_E. No extra tracking needed.

    Pre-fills the loan question as 'y' for merchants matching BNPL/debt
    keywords so the user just hits Enter rather than typing for obvious cases.
    """
    commitments = []

    if not candidates:
        print("\nNo recurring payments detected automatically.")
        return commitments

    print("\n" + "=" * 65)
    print("DETECTED RECURRING PAYMENTS")
    print("=" * 65)
    for i, c in enumerate(candidates, 1):
        tag = "  [LOAN/BNPL?]" if c["likely_loan"] else ""
        print(f"  {i:>2}) {c['merchant']:<30} £{c['amount']:>8.2f}  "
              f"{c['frequency']:<14} conf={c['confidence']:.0%}{tag}")
    print()

    for c in candidates:
        print(f"\n{'─' * 65}")
        print(f"  {c['merchant']}  £{c['amount']} {c['frequency']}")

        # Pre-fill loan answer for obvious BNPL/debt merchants
        default_loan = "y" if c["likely_loan"] else "n"
        is_loan = input(
            f"  Is this a loan / debt repayment? (y/n) [{default_loan}]: "
        ).strip().lower() or default_loan

        if is_loan != "y":
            # Not a loan — leave it in E, nothing more to ask
            continue

        # --- Loan follow-up questions ---

        # Q2: Still active?
        active = input("  Still active going forward? (y/n): ").strip().lower() == "y"

        stopped_recently = False
        if not active:
            stopped_recently = input(
                "  Did it stop in the last 1-3 months? (y/n): "
            ).strip().lower() == "y"

        # Q3: End date
        months_remaining = None  # None = indefinite
        if active:
            end_input = input(
                "  Months remaining? (Enter for indefinite): "
            ).strip()
            if end_input:
                try:
                    months_remaining = int(end_input)
                except ValueError:
                    months_remaining = None  # bad input → treat as indefinite

        # Q4: APR
        apr_input = input("  APR % (Enter to skip / 0%): ").strip()
        try:
            apr = float(apr_input) if apr_input else 0.0
        except ValueError:
            apr = 0.0

        monthly_amount = to_monthly_amount(c["amount"], c["frequency"])

        commitments.append({
            "merchant":          c["merchant"],
            "amount_per_period": c["amount"],
            "monthly_amount":    round(monthly_amount, 2),
            "frequency":         c["frequency"],
            "active":            active,
            "stopped_recently":  stopped_recently,
            "months_remaining":  months_remaining,  # None = indefinite
            "apr":               apr,
            "source":            "detected",
        })

    return commitments


# ============================================================
# STEP 5 — MANUAL LOAN ENTRY
# ============================================================

def add_manual_commitments_cli(commitments: list[dict]) -> list[dict]:
    """
    Asks the user if there are any loans/debts we missed entirely.

    Common reasons for misses:
    - Brand-new loan (< 3 transactions so far, below MIN_REPEATS)
    - Payment merchant name varies each month
    - Loan just agreed, first payment not yet taken
    - Repayment comes from a different account

    Only asks about loans here — regular expenses don't need manual entry
    since they're already captured in the outflow totals.
    """
    print("\n" + "=" * 65)
    print("ANY LOANS WE MISSED?")
    print("=" * 65)

    while True:
        if input("\nAny loan / debt repayment we missed? (y/n): ").strip().lower() != "y":
            break

        merchant = input("  Lender / name: ").strip() or "Manual Entry"

        try:
            amount = float(input("  Monthly repayment (£): ").strip())
        except ValueError:
            print("  Invalid amount — skipping.")
            continue

        end_input = input("  Months remaining? (Enter for indefinite): ").strip()
        try:
            months_remaining = int(end_input) if end_input else None
        except ValueError:
            months_remaining = None

        apr_input = input("  APR % (Enter to skip / 0%): ").strip()
        try:
            apr = float(apr_input) if apr_input else 0.0
        except ValueError:
            apr = 0.0

        commitments.append({
            "merchant":          merchant,
            "amount_per_period": amount,
            "monthly_amount":    round(amount, 2),
            "frequency":         "monthly",
            "active":            True,
            "stopped_recently":  False,
            "months_remaining":  months_remaining,
            "apr":               apr,
            "source":            "manual",
        })
        print(f"  Added {merchant} — £{amount:.2f}/month")

    return commitments


# ============================================================
# STEP 6 — MONTHLY AGGREGATION
# ============================================================

def build_monthly_series(txns: list[dict]) -> tuple[list[str], list[float], list[float]]:
    """
    Buckets all transactions into calendar months.

    Returns three parallel lists sorted chronologically:
        months         — ["2023-09", "2023-10", ...]
        income_series  — total income per month
        outflow_series — total outflow per month (everything, including loans)

    We subtract D_current in compute_params to isolate essential spend.
    """
    totals: dict[str, dict] = defaultdict(lambda: {"income": 0.0, "outflow": 0.0})

    for t in txns:
        key = _month_key(t["date"])
        if t["amount"] >= 0:
            totals[key]["income"]  += t["amount"]
        else:
            totals[key]["outflow"] += abs(t["amount"])

    months = sorted(totals.keys())
    return (
        months,
        [totals[m]["income"]  for m in months],
        [totals[m]["outflow"] for m in months],
    )


# ============================================================
# STEP 7 — WEIGHTED STATISTICS
# ============================================================

def exponential_weights(n: int) -> list[float]:
    """
    Normalised exponential decay weights, newest month last.
    With HALF_LIFE_MONTHS=4, a month 8 months ago has half the weight
    of the current month — makes mu/sigma respond to recent changes.
    """
    lam     = math.log(2) / HALF_LIFE_MONTHS
    weights = [math.exp(-lam * (n - 1 - i)) for i in range(n)]
    total   = sum(weights)
    return [w / total for w in weights]


def weighted_mean_var(series: list[float], weights: list[float]) -> tuple[float, float]:
    """
    Weighted mean and variance.
        mu    = Σ w_i x_i
        sigma² = Σ w_i (x_i - mu)²
    """
    mu  = sum(w * x for w, x in zip(weights, series))
    var = sum(w * (x - mu) ** 2 for w, x in zip(weights, series))
    return mu, var


# ============================================================
# STEP 8 — PARAMETER COMPUTATION (pure function, no I/O)
# ============================================================

def compute_params(txns: list[dict], commitments: list[dict]) -> dict:
    """
    Computes final model parameters.

    D_current = sum of monthly amounts for ACTIVE loans only.
    Inactive loans contribute 0 — this stops paid-off loans biasing D.

    Essential spend E = outflow - D_current each month.
    This strips loan repayments out so they're only counted once, in D,
    and not also inflating mu_E.

    loan_rates = 1-D array of APR% for each active loan.
    """
    active_loans = [c for c in commitments if c["active"]]

    D_current  = sum(c["monthly_amount"] for c in active_loans)
    loan_rates = [c["apr"] for c in active_loans]

    months, income_series, outflow_series = build_monthly_series(txns)

    if not months:
        return {
            "mu_I":              0.0,
            "sigma_I2":          0.0,
            "mu_E":              0.0,
            "sigma_E2":          0.0,
            "D_current_monthly": round(D_current, 2),
            "loan_rates":        loan_rates,
            "commitments":       commitments,
        }

    weights = exponential_weights(len(months))

    mu_I, var_I = weighted_mean_var(income_series, weights)

    # Strip active loan repayments from outflow to isolate essential spend
    essential_series = [max(0.0, out - D_current) for out in outflow_series]
    mu_E, var_E      = weighted_mean_var(essential_series, weights)

    return {
        "mu_I":              round(mu_I,  2),
        "sigma_I2":          round(var_I, 2),
        "mu_E":              round(mu_E,  2),
        "sigma_E2":          round(var_E, 2),
        "D_current_monthly": round(D_current, 2),
        "loan_rates":        [round(r, 4) for r in loan_rates],
        "commitments":       commitments,
    }


# ============================================================
# PUBLIC ENTRY POINT
# ============================================================

def build_params_interactive(transaction_dict: dict) -> dict:
    """
    Full pipeline: ingest → detect → confirm → add manual loans → compute.

    Pass in the dict from your friend's CSV transformer directly.

    Example:
        transaction_dict = friend_transformer("bank_export.csv")
        params = build_params_interactive(transaction_dict)

        mu_S  = params["mu_I"] - params["mu_E"] - params["D_current_monthly"]
        sig_S = sqrt(params["sigma_I2"] + params["sigma_E2"])
        PD    = Phi((-B - mu_S) / sig_S)
    """
    txns = load_transactions(transaction_dict)
    print(f"\nLoaded {len(txns)} transactions.")

    candidates  = detect_recurring(txns)
    commitments = confirm_commitments_cli(candidates)
    commitments = add_manual_commitments_cli(commitments)
    params      = compute_params(txns, commitments)

    return params


# ============================================================
# CLI RUNNER (testing only)
# ============================================================

if __name__ == "__main__":
    """
    For testing only. Run with a CSV:
        python bnpl_param_builder.py test_transactions.csv

    In production, import and call:
        params = build_params_interactive(transaction_dict)
    """
    csv_path = sys.argv[1] if len(sys.argv) > 1 else input("Path to CSV file: ").strip()
    data     = csv_to_transaction_dict(csv_path)
    params   = build_params_interactive(data)

    print("\n" + "=" * 65)
    print("OUTPUT PARAMETERS (for Normal model)")
    print("=" * 65)
    print(params)