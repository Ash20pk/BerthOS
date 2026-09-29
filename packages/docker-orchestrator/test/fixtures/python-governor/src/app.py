import sys

from berth_sdk import define_app


# A governs: true app written in Python: denies any export named "blocked",
# allows the rest, and logs what it was asked so the milestone can see that a
# Node app's gate reached it too.
def evaluate(input):
    print(f"[python-governor] evaluate {input.get('app')}.{input.get('export')} from {input.get('caller')}", file=sys.stderr, flush=True)
    if input.get("export") == "blocked":
        return {"allowed": False, "reason": "blocked by python-governor"}
    return {"allowed": True}


app = define_app(lambda a: a.export("evaluate_action", evaluate))
