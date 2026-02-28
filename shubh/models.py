from pydantic import BaseModel
from typing import List, Optional

class SavingsGoal(BaseModel):
    name: str
    target_amount: float
    timeframe_months: int

class Debt(BaseModel):
    category: str           # e.g. "Mortgage", "Car Loan", "Credit Card", "Student Loan", "Other"
    label: str              # user-facing name, may be custom
    total_amount: float     # total outstanding balance
    monthly_payment: float
    apr: float              # annual percentage rate (%)
    months_remaining: Optional[float] = None
    # None = indefinite (revolving/open-ended debt, e.g. credit card with no payoff plan)
    # float rather than int so downstream code can store math.inf if needed

class UserOnboarding(BaseModel):
    name: str
    current_savings: float
    average_income: float
    average_expenses: float
    credit_limit: float
    savings_goals: List[SavingsGoal]
    debts: List[Debt] = []