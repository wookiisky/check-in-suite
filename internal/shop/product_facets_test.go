package shop

import "testing"

// 同包的旧素材可能没有名称，来源选项仍须按供应方和包身份唯一合并。
func TestProductFacetsMergePackNamesByIdentity(t *testing.T) {
	for _, items := range [][]Product{
		{{Provider: "kaykit", PackKey: "kaykit-adventurers"}, {Provider: "kaykit", PackKey: "kaykit-adventurers", PackName: "KayKit Adventurers"}},
		{{Provider: "kaykit", PackKey: "kaykit-adventurers", PackName: "KayKit Adventurers"}, {Provider: "kaykit", PackKey: "kaykit-adventurers"}},
	} {
		result := productFacets(items)
		if len(result.Packs) != 1 || result.Packs[0].Key != "kaykit-adventurers" || result.Packs[0].Provider != "kaykit" || result.Packs[0].Name != "KayKit Adventurers" {
			t.Fatalf("duplicate or unnamed facet: %+v", result)
		}
		if len(result.Providers) != 1 || result.Providers[0] != "kaykit" {
			t.Fatalf("provider facets=%+v", result)
		}
	}
}
