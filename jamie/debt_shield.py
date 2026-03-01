from __future__ import annotations
import math
import json
from dataclasses import dataclass, field, asdict
from datetime import date, timedelta
from typing import Literal
from enum import Enum


# CONSTANTS

DEFAULT_APRS: dict[str, float] = {
    "credit_card": 24.9,
    "personal_loan": 12.5,
    "student_loan": 5.4,
    "car_finance": 9.9,
    "overdraft": 39.9,
    "mortgage": 4.5,
    "other": 18.0,
}

RISK_WEIGHTS = {
    "delay":    0.30,
    "interest": 0.25,
    "income":   0.25,
    "critical": 0.20,
}

class RiskLevel(str, Enum):
    LOW     = "low"
    CAUTION = "caution"
    HIGH    = "high"

def calculate_debt_shield():
    return None


def fetch_readiness_score():
    return None

def calculate_website_risk():
    return None

def intervene():
    return None

def cooldown_timer():
    return None

def calculate_extra_interest():
    return None

def calculate_debt_free_delay():
    return None

def snooze():
    return None
