# berth-sdk

Python resident-app SDK for [Berth](https://github.com/Ash20pk/BerthOS) — IAM for agents — declared capabilities, kernel-enforced, audit-trailed. Speaks the same wire protocols as `@berth/sdk` (newline-JSON RPC framing, the `berth.yml` manifest shape) with idiomatic Python runtime glue.

```sh
pip install berth-sdk
```

## Usage

```python
from berth_sdk import define_app


def setup(app):
    # runs inside the sandbox; capabilities come from berth.yml
    app.export("greet", lambda inp: {"message": f"hello {inp['name']}"})


app = define_app(setup)
```

## Documentation

- [Python SDK reference](https://github.com/Ash20pk/BerthOS/blob/main/docs/sdk-python-reference.md)
- Repo: https://github.com/Ash20pk/BerthOS
