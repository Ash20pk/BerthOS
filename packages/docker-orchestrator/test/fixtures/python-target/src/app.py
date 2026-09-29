from berth_sdk import define_app
app = define_app(lambda a: a.export("whoami", lambda _i: {"target": "python-target"}))
