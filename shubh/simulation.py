def simulate_purchase(user, purchase_amount):
    # Example: update projected savings and credit utilization
    new_credit_utilization = purchase_amount / user.credit_limit
    new_savings = user.current_savings - purchase_amount
    return {
        "new_credit_utilization": new_credit_utilization,
        "projected_savings": new_savings
    }