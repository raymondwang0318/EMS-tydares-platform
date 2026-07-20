import json, urllib.request, urllib.error, sys
T = sys.argv[1]
stage = sys.argv[2] if len(sys.argv) > 2 else "all"
BASE = "http://localhost:8080"
VC = "ems_session=p12a-verify-viewer-20260617"

def req(method, path, headers, body=None):
    data = json.dumps(body).encode() if body else None
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        return urllib.request.urlopen(r).status
    except urllib.error.HTTPError as e:
        return e.code

bearer = {"Authorization": "Bearer " + T, "Content-Type": "application/json"}
viewer = {"Cookie": VC, "Content-Type": "application/json"}
ctrl = lambda h: req("POST", "/v1/admin/io/devices/nonexist-dev/channels/1/control", h, {"state": False, "actor": "verify"})
cmd = lambda h, ct: req("POST", "/v1/commands", h, {"edge_id": "NONEXIST", "device_id": "x", "command_type": ct, "payload": {}, "priority": 5, "issued_by": "verify"})

if stage in ("false", "all"):
    print("=== Bearer(admin+io=TRUE) ===")
    print("  control_do 不存在device  -> %s  (期望404=通過can_control_io到device檢查)" % ctrl(bearer))
    print("  /commands relay.set      -> %s  (期望非403=通過io檢查)" % cmd(bearer, "relay.set"))
    print("=== viewer cookie (io=FALSE) ===")
    print("  control_do               -> %s  (期望403 無I/O控制權限)" % ctrl(viewer))
    print("  /commands relay.set      -> %s  (期望403)" % cmd(viewer, "relay.set"))
    print("  /commands device.scan    -> %s  (期望403 viewer管理命令)" % cmd(viewer, "device.scan"))
    print("  GET /alerts/active       -> %s  (期望200 viewer能讀)" % req("GET", "/v1/alerts/active", viewer))

if stage in ("true", "all"):
    print("=== viewer cookie (io=TRUE 現場操作員) ===")
    print("  control_do               -> %s  (期望404=通過can_control_io到device檢查)" % ctrl(viewer))
    print("  /commands relay.set      -> %s  (期望非403=現場操作員能控)" % cmd(viewer, "relay.set"))
    print("  /commands device.scan    -> %s  (期望403 viewer仍不能下管理命令)" % cmd(viewer, "device.scan"))
