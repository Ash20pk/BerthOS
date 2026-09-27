# berthos-sdk

Build a Berth resident app in Python. It uses the same `berth.yml` manifest, RPC protocol and context bus as the TypeScript SDK, `@berthos/sdk`.

[Berth](https://github.com/Ash20pk/BerthOS) runs an AI agent's tools in a sandbox. Each tool declares what it may touch in a `berth.yml` manifest, and the Linux kernel enforces it.

```sh
pip install berthos-sdk
```

Needs Python 3.11+. The import name is `berth_sdk`.

## Usage

```python
from berth_sdk import define_app
from pydantic import BaseModel


class GreetInput(BaseModel):
    name: str


class GreetOutput(BaseModel):
    message: str


def setup(app):
    app.export(
        "greet",
        lambda inp: GreetOutput(message=f"hello {inp.name}"),
        input_model=GreetInput,
        output_model=GreetOutput,
    )


app = define_app(setup)
```

Declare `greet` under `exports` in `berth.yml` too. Without `input_model`, a handler receives the raw input dict. Run the app with `berth dev` from [`@berthos/cli`](https://www.npmjs.com/package/@berthos/cli); the [`hello-world-py`](https://github.com/Ash20pk/BerthOS/tree/main/apps/hello-world-py) app is a complete example.

## Docs

[Python SDK reference](https://github.com/Ash20pk/BerthOS/blob/main/docs/sdk-python-reference.md) · [Python and the context bus](https://github.com/Ash20pk/BerthOS/blob/main/docs/sdk-python-context-bus-reference.md) · [Repo](https://github.com/Ash20pk/BerthOS)
