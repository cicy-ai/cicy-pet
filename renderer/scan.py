#!/usr/bin/env python3
"""扫描 models/ 生成 models.json。

加模型 = 往 models/ 丢个文件夹，跑一次本脚本，页面自动出现，无需改代码。

关键：顺带读出 .moc3 的版本号。渲染库 pixi-live2d-display（含维护中的 advanced 分支）
内部的 Cubism Framework 只支持到 moc3 v5；v6 的模型 Core 能解析、但一渲染就抛
"Cannot read properties of undefined" 并白屏。所以这里把版本标出来，页面据此
直接给用户一句人话，而不是让他对着一片黑猜。
"""
import json, os, glob, struct

MAX_SUPPORTED_MOC = 5

# 渲染核对过的分类（不是按名字猜的）
KIND = {
    "Hiyori": "女生", "Haru": "女生", "Mao": "女生", "Rice": "女生", "Ren": "女生",
    "shizuku": "女生", "z16": "女生", "nietzsche": "女生",
    "Mark": "男生", "Natori": "男生", "haruto": "男生",
    "Wanko": "宠物", "hijiki": "宠物", "tororo": "宠物",
}

# 授权。直播 / 录播 / 任何对外发布之前必须看这一栏 —— 依据是 Live2D 的
# Free Material License 和 Sample Model Terms 原文（详见知识库）。
#
#   ok        Live2D 原创角色。个人和年营收 < 1000 万日元的小企业可商用（含变现直播、
#             录播），但必须署名、不得改设计、不得分发模型文件本身。
#   nc        合作角色（Collaboration Character）。原文：“You may neither use
#             Collaboration Character and the related data for commercial purposes
#             nor alter nor distribute them.” → 出镜发布 = 商用 = 不行。
#   unknown   不在 Live2D 的名单里，来自社区 widget 包，来源与授权不明，很可能是
#             第三方甚至游戏角色。自己玩没人管，公开发布有法律风险 → 别用。
LICENSE = {
    "Hiyori": "ok", "Haru": "ok", "Mao": "ok", "Mark": "ok", "Rice": "ok",
    "Wanko": "ok", "Ren": "ok", "shizuku": "ok", "tororo": "ok", "hijiki": "ok",
    "haruto": "ok",
    "Natori": "nc",
    "z16": "unknown", "nietzsche": "unknown",
}

LICENSE_LABEL = {
    "ok": "可商用",
    "nc": "禁商用",
    "unknown": "来源不明",
}

LICENSE_NOTE = {
    "ok": "Live2D 原创角色。个人／小企业（年营收 < 1000 万日元）可用于直播和录播，"
          "包括变现。必须在简介里署名「This content uses sample data owned and "
          "copyrighted by Live2D Inc.」，不得改设计，不得分发模型文件本身。",
    "nc": "合作角色，条款明确禁止一切商用。出镜发布就算商用 —— 直播、录播都不行。",
    "unknown": "不在 Live2D 的授权名单里，来自社区模型包，来源和授权不明。"
               "自己在桌面上玩没问题，公开发布有侵权风险。",
}


def moc3_version(path: str):
    """.moc3 头部：magic 'MOC3' + 1 字节版本号。Cubism 2 的 .moc 没有这个头。"""
    try:
        with open(path, "rb") as f:
            head = f.read(5)
        if head[:4] != b"MOC3":
            return None
        return head[4]
    except Exception:
        return None


def main():
    root = os.path.dirname(os.path.abspath(__file__))
    os.chdir(root)

    out = []
    for d in sorted(os.listdir("models")):
        p = os.path.join("models", d)
        if not os.path.isdir(p):
            continue

        entry = (glob.glob(f"{p}/**/*.model3.json", recursive=True)
                 or glob.glob(f"{p}/**/*.model.json", recursive=True))
        if not entry:
            print(f"  ! 跳过 {d}：找不到 model3.json / model.json")
            continue
        entry = entry[0].replace("\\", "/")

        cubism = 4 if entry.endswith(".model3.json") else 2
        moc = None
        if cubism == 4:
            with open(entry, encoding="utf-8") as f:
                ref = json.load(f)["FileReferences"]["Moc"]
            moc = moc3_version(os.path.join(os.path.dirname(entry), ref))

        lic = LICENSE.get(d, "unknown")
        item = {
            "id": d,
            "name": d,
            "kind": KIND.get(d, "其他"),
            "cubism": cubism,
            "url": entry,
            "moc": moc,
            "supported": moc is None or moc <= MAX_SUPPORTED_MOC,
            "license": lic,
            "licenseLabel": LICENSE_LABEL[lic],
            "licenseNote": LICENSE_NOTE[lic],
            "publishable": lic == "ok",     # 能不能对外发布（直播／录播）
        }
        out.append(item)

        flag = "" if item["supported"] else f"  ← moc v{moc}，渲染库不支持"
        print(f"  {item['kind']:4s} cubism{cubism}  {d:12s} [{LICENSE_LABEL[lic]}]{flag}")

    with open("models.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    bad = [m["id"] for m in out if not m["supported"]]
    print(f"\n共 {len(out)} 个" + (f"，其中 {len(bad)} 个不受支持：{', '.join(bad)}" if bad else ""))


if __name__ == "__main__":
    main()
