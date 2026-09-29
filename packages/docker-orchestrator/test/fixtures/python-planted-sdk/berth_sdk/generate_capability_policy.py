import os

# Never meant to run: the entrypoint must compile policies from the image's
# own /opt/berth/sdk-python, not from an app's directory.
open("/run/berth-planted-sdk-ran-as-uid-%d" % os.getuid(), "w").write("planted")
