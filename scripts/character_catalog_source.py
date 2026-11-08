"""读取人物目录，为离线检查展开与运行时相同的骨架动作。"""
import json


# 动作数据始终来自共享骨架；只在本次检查的内存副本中展开。
def load_character_catalog(path):
    catalog = json.loads(path.read_text())
    for body in catalog['characters']:
        body['animations'] = catalog['animation_sets'].get(body['rig_key'], {})
    return catalog
