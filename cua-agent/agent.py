#!/usr/bin/env python3
# 云桌面内运行的 CUA 执行体（PRD 6.15 执行—自检—纠错循环）。
# 部署在无影 Windows 云桌面里，长驻回连服务端，接收原子动作（6.15.2 字典）并执行；
# 每步动作后截屏回传，由服务端主脑判读画面做自检/纠错（≤3 次重试）。
#
# 依赖（云桌面内 pip install）：pyautogui pillow websocket-client requests
# 启动：python agent.py --server wss://你的域名/cua --token $CUA_AGENT_TOKEN --desktop ecd-xxx
#
# 说明：本文件是云桌面侧客户端，不在服务端进程内运行。服务端通过无影 RunCommand
# 把它部署进云桌面并拉起（见 server/src/cua/wuying.py 的 runPowerShell 通道）。

import argparse
import base64
import io
import json
import time
import sys

try:
    import pyautogui
    import websocket  # websocket-client
    from PIL import Image
except ImportError:
    print("请在云桌面内安装依赖: pip install pyautogui pillow websocket-client", file=sys.stderr)
    raise

pyautogui.FAILSAFE = False
pyautogui.PAUSE = 0.3


def screenshot_b64(max_w=1280):
    img = pyautogui.screenshot()
    if img.width > max_w:
        r = max_w / img.width
        img = img.resize((max_w, int(img.height * r)))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=70)
    return base64.b64encode(buf.getvalue()).decode()


def do_action(op, params):
    """执行一个原子动作（6.15.2 冻结字典）。target 支持坐标；自然语言定位由服务端主脑
    先做视觉定位再下发坐标（本地不做模型推理）。"""
    if op == "open_app":
        target = params.get("target", "")
        pyautogui.hotkey("win", "r")
        time.sleep(0.5)
        exe = {"browser": "msedge", "PowerPoint": "powerpnt", "Word": "winword", "Excel": "excel"}.get(target, target)
        pyautogui.typewrite(exe, interval=0.02)
        pyautogui.press("enter")
        time.sleep(2.0)
    elif op == "navigate":
        pyautogui.hotkey("ctrl", "l"); time.sleep(0.3)
        pyautogui.typewrite(params["url"], interval=0.01); pyautogui.press("enter"); time.sleep(2.0)
    elif op == "type":
        if "x" in params and "y" in params:
            pyautogui.click(params["x"], params["y"]); time.sleep(0.2)
        pyautogui.typewrite(params.get("text", ""), interval=0.02)
    elif op in ("click", "double_click"):
        x, y = params["x"], params["y"]
        (pyautogui.doubleClick if op == "double_click" else pyautogui.click)(x, y)
    elif op == "drag":
        pyautogui.moveTo(params["from"][0], params["from"][1])
        pyautogui.dragTo(params["to"][0], params["to"][1], duration=0.5)
    elif op == "scroll":
        amount = params.get("amount", 500) * (1 if params.get("direction") == "down" else -1)
        pyautogui.scroll(-amount)
    elif op == "key":
        pyautogui.hotkey(*params["keys"])
    elif op == "wait_for":
        time.sleep(params.get("timeout", 2))
    elif op == "screenshot":
        pass  # 截屏在每步末尾统一回传
    else:
        return {"ok": False, "reason": f"unknown_op:{op}"}
    return {"ok": True}


def run(server, token, desktop):
    url = f"{server}?role=cua&token={token}&desktop={desktop}"
    ws = websocket.create_connection(url, timeout=30)
    ws.send(json.dumps({"type": "cua_ready", "desktop": desktop, "shot": screenshot_b64()}))
    print("cua-agent connected", flush=True)
    while True:
        try:
            raw = ws.recv()
        except Exception:
            time.sleep(2)
            try:
                ws = websocket.create_connection(url, timeout=30)
                continue
            except Exception:
                break
        if not raw:
            continue
        msg = json.loads(raw)
        if msg.get("type") == "cua_action":
            aid = msg.get("action_id")
            try:
                res = do_action(msg["op"], msg.get("params", {}))
            except Exception as e:
                res = {"ok": False, "reason": str(e)}
            time.sleep(0.4)
            ws.send(json.dumps({"type": "cua_result", "action_id": aid, **res, "shot": screenshot_b64()}))
        elif msg.get("type") == "ping":
            ws.send(json.dumps({"type": "pong"}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", required=True, help="wss://域名/cua")
    ap.add_argument("--token", required=True)
    ap.add_argument("--desktop", required=True)
    args = ap.parse_args()
    while True:
        try:
            run(args.server, args.token, args.desktop)
        except Exception as e:
            print("agent error, retry in 5s:", e, file=sys.stderr, flush=True)
            time.sleep(5)
