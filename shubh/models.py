from pydantic import BaseModel
from typing import List, Optional

class SavingsGoal(BaseModel):
    name: str
    target_amount: float
    priority: int = 1           # 1 = highest priority; lower number = more weight
    timeframe_months: Optional[int] = None  # deprecated, kept for backward compat

class Debt(BaseModel):
    category: str
    label: str
    total_amount: float
    monthly_payment: float
    apr: float
    months_remaining: Optional[float] = None

class UserOnboarding(BaseModel):
    name: str
    current_savings: float
    average_income: float
    average_expenses: float
    var_income: Optional[float] = None
    var_expenses: Optional[float] = None
    credit_limit: float
    savings_allocation_pct: float = 50.0   # % of monthly surplus allocated to savings goals
    savings_goals: List[SavingsGoal]
    debts: List[Debt] = []