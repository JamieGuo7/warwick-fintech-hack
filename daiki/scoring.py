import math
import numpy as np


def prob_default_12m(
    mu_I: float,
    mu_E: float,
    var_I: float,
    var_E: float,
    d: list[float],
    p: list[float],
    t: list[float],
    r: list[float],
    B0: float = 0.0,
    N: int = 200_000,
    rho_IE: float = 0.0,
    seed: int = 42,
) -> float:
    """
    Estimate the probability of defaulting at least once in the next 12 months
    via Monte Carlo simulation.

    Parameters
    ----------
    mu_I    : Mean monthly income.
    mu_E    : Mean monthly expenses (excluding debt payments).
    var_I   : Variance of monthly income.
    var_E   : Variance of monthly expenses.
    d       : List of current debt balances.
    p       : List of fixed monthly payments, one per debt.
    t       : List of payment durations (in months). Use math.inf for
              indefinite / interest-only loans. After t[i] months the loan
              is expected to be fully paid; any residual balance is treated
              as a balloon payment due at that month.
    r       : List of monthly interest rates, one per debt.
    B0      : Starting cash balance (default 0).
    N       : Number of Monte Carlo trials (default 200,000).
    rho_IE  : Pearson correlation between income and expense shocks
              (default 0, i.e. independent).
    seed    : Random seed for reproducibility.

    Returns
    -------
    float : Estimated probability of default within 12 months.

    Notes
    -----
    Default is defined as the cash balance B falling below zero after
    meeting all required debt obligations in any single month.

    Income and expenses are modelled as correlated Gaussians. Debt balances
    accrue interest at the start of each month, then the required payment
    (or balloon) is subtracted. A debt is skipped once its balance reaches
    zero or below.
    """

    # ------------------------------------------------------------------ #
    # Input validation
    # ------------------------------------------------------------------ #
    k = len(d)
    if not (len(p) == len(t) == len(r) == k):
        raise ValueError("d, p, t, and r must all have the same length.")
    if var_I < 0 or var_E < 0:
        raise ValueError("Variances must be non-negative.")
    if not (-1.0 <= rho_IE <= 1.0):
        raise ValueError("rho_IE must be in [-1, 1].")
    if N <= 0:
        raise ValueError("N must be a positive integer.")

    d = np.array(d, dtype=float)
    p = np.array(p, dtype=float)
    t = np.array(t, dtype=float)   # may contain math.inf
    r = np.array(r, dtype=float)

    sigma_I = math.sqrt(var_I)
    sigma_E = math.sqrt(var_E)

    rng = np.random.default_rng(seed)

    # ------------------------------------------------------------------ #
    # Pre-generate all standard-normal draws: shape (N, 12, 2)
    # Drawing everything up front is far faster than per-trial loops.
    # ------------------------------------------------------------------ #
    Z = rng.standard_normal((N, 12, 2))   # Z[..., 0]=Z1, Z[..., 1]=Z2

    # Apply income/expense correlation
    # I = mu_I + sigma_I * Z1
    # E = mu_E + sigma_E * (rho * Z1 + sqrt(1-rho^2) * Z2)
    income   = mu_I + sigma_I * Z[..., 0]                                         # (N, 12)
    expenses = mu_E + sigma_E * (rho_IE * Z[..., 0]
                                 + math.sqrt(max(0.0, 1.0 - rho_IE**2)) * Z[..., 1])  # (N, 12)

    net_cash_flow = income - expenses   # (N, 12)

    # ------------------------------------------------------------------ #
    # Simulate month-by-month (vectorised over all N trials at once)
    # ------------------------------------------------------------------ #
    B   = np.full(N, B0, dtype=float)        # cash balances
    bal = np.tile(d, (N, 1))                 # debt balances: (N, k)

    # Track which trials have already defaulted so we stop updating them.
    defaulted = np.zeros(N, dtype=bool)

    for m in range(1, 13):
        # Skip fully defaulted trials
        active = ~defaulted

        # --- accrue interest on positive balances ---
        positive = bal > 0                                    # (N, k)
        bal[active] += (bal * r)[active] * positive[active]  # only positive balances

        # --- determine required payment for each debt this month ---
        # A debt requires payment while m <= t[i] AND balance > 0.
        within_term = (m <= t)          # (k,) broadcast across all trials
        has_balance = bal > 1e-9        # (N, k)

        # Normal scheduled payment (capped at remaining balance)
        scheduled = np.minimum(p, bal)                           # (N, k)
        scheduled = np.where(within_term & has_balance, scheduled, 0.0)

        # Balloon payment: if m == t[i] (last scheduled month) pay off
        # any residual balance that the fixed payment didn't cover.
        # This fixes the "interest accrues silently after term" bug.
        is_last_month = (m == t)        # (k,)
        residual = np.where(is_last_month & has_balance, bal - scheduled, 0.0)

        # Total required outflow
        total_required = scheduled.sum(axis=1) + residual.sum(axis=1)   # (N,)

        # --- update cash ---
        B[active] += net_cash_flow[active, m - 1]
        B[active] -= total_required[active]

        # --- record new defaults ---
        defaulted |= (B < 0)

        # --- reduce debt balances by payments made ---
        payments_made = scheduled + residual                    # (N, k)
        bal -= payments_made
        bal = np.maximum(bal, 0.0)    # prevent floating-point negatives

    return float(defaulted.sum()) / N

# ---------------------------------------------------------------------- #
# Example usage
# ---------------------------------------------------------------------- #
prob = prob_default_12m(
        mu_I    = 5_000,        # £5,000 average monthly income
        mu_E    = 3_500,        # £3,500 average monthly expenses
        var_I   = 250_000,      # std dev ~£500
        var_E   = 160_000,      # std dev ~£400
        d       = [10_000, 100_000],          # two debts
        p       = [300,    200],            # monthly payments
        t       = [36,     math.inf],       # 3-year term loan + revolving
        r       = [0.005,  0.015],          # 0.5% and 1.5% monthly
        B0      = 100,
        N       = 200_000,
        rho_IE  = 0
    )

prob2 = prob_default_12m(
    mu_I = 3_000,
    mu_E = 2_000,
    var_I = 2_500,
    var_E = 1_600,
    d = [10_000, 30_000, 100_000],
    p = [100, 150, 800],
    t = [100, 200, math.inf], 
    r = [0.005, 0.0015, 0.03],
    B0 = 1_000,
    N = 200_000,
    rho_IE = 0
)

print(prob)