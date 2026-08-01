from berth_sdk import define_app
from pydantic import BaseModel


class GreetInput(BaseModel):
    name: str


class GreetOutput(BaseModel):
    message: str


def _greet(input: GreetInput) -> GreetOutput:
    return GreetOutput(message=f"Hello, {input.name}! (from a real Python resident app)")


def _setup(a):
    a.export("greet", _greet, input_model=GreetInput, output_model=GreetOutput)


app = define_app(_setup)
