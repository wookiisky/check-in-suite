"""历史身份映射只接受明确来源，并在后续重加工时保留旧关系。"""

import importlib.util
import json
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location('spatial_aliases', Path(__file__).with_name('update-spatial-thumbnail-aliases.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SpatialThumbnailAliasesTest(unittest.TestCase):
    # 明确发布身份和加工历史指向同一物件，当前版本本身不占用别名。
    def test_explicit_history_and_future_regeneration(self):
        source = {'items': [{'item_key': 'chair', 'thumbnail_asset_key': 'chair-current', 'published_thumbnail_asset_key': 'chair-published', 'previous_library_versions': [{'thumbnail_asset_key': 'chair-before'}]}], 'definitions': [{'item_key': 'chair', 'thumbnail_asset_key': 'chair-current'}]}
        data = json.dumps(source).encode()
        first = MODULE.build_aliases({'chair': 'chair-current'}, {}, [('git-blob:reviewed-history', data)])
        self.assertEqual(first['aliases'], {'chair-before': 'chair', 'chair-published': 'chair'})
        self.assertEqual(len(first['sources'][0]['sha256']), 64)
        next_source = json.dumps({'items': [{'item_key': 'chair', 'thumbnail_asset_key': 'chair-next', 'previous_library_versions': [{'thumbnail_asset_key': 'chair-current'}]}]}).encode()
        second = MODULE.build_aliases({'chair': 'chair-next'}, first, [('next-manifest', next_source)])
        self.assertEqual(second['aliases'], {'chair-before': 'chair', 'chair-current': 'chair', 'chair-published': 'chair'})
        self.assertEqual(len(second['sources']), 2)

    # 拼写相近不构成身份关系，冲突的显式证据不能静默覆盖。
    def test_no_prefix_guessing_and_no_conflicting_identity(self):
        data = json.dumps({'items': [{'item_key': 'other', 'thumbnail_asset_key': 'chair-looking-image'}]}).encode()
        result = MODULE.build_aliases({'chair': 'chair-current'}, {}, [('unrelated', data)])
        self.assertEqual(result['aliases'], {})
        with self.assertRaises(ValueError):
            MODULE.build_aliases({'chair': 'new-chair', 'table': 'new-table'}, {'aliases': {'shared-old': 'chair'}}, [('conflicting', json.dumps({'items': [{'item_key': 'table', 'thumbnail_asset_key': 'shared-old'}]}).encode())])


if __name__ == '__main__':
    unittest.main()
