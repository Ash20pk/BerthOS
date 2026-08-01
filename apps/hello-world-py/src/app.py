from berth_sdk import define_app
from pydantic import BaseModel


class GreetInput(BaseModel):
    name: str


class GreetOutput(BaseModel):
    message: str


def _greet(input: GreetInput) -> GreetOutput:
    return GreetOutput(message=f"Hello, {input.name}! (from a real Python resident app)")


class PublishFileCreatedInput(BaseModel):
    path: str
    created_by: str


# Captured at on_agent_ready and read inside the export handler below —
# export handlers only receive their own input, not the AppContext, so
# publishing from one requires closing over the context bus reference like
# this — same pattern apps/filesystem's TS code uses for the same reason.
_context_bus = None


def _on_agent_ready(ctx):
    global _context_bus
    _context_bus = ctx.context_bus
    _context_bus.register("hello-world-py")


def _publish_file_created(input: PublishFileCreatedInput) -> None:
    # Real cross-language context-bus publish: apps/code-editor (TypeScript)
    # already subscribes to "fs.file_created" with exactly this
    # {path, createdBy} shape (see its own src/index.ts) — no changes needed
    # on that side to prove a Python app's publish reaches a TS subscriber.
    _context_bus.publish("fs.file_created", {"path": input.path, "createdBy": input.created_by})


def _setup(a):
    a.export("greet", _greet, input_model=GreetInput, output_model=GreetOutput)
    a.export("publish_file_created", _publish_file_created, input_model=PublishFileCreatedInput)
    a.on_agent_ready(_on_agent_ready)


app = define_app(_setup)
