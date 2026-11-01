import { useId, useState } from 'react';
import type { CatalogFacets, CatalogSearch } from './useProductCatalog';
import content from './content.json';

// 搜索显式提交，来源与素材包切换直接重新查询全部目录。
export function CatalogFilters({ value, facets, onChange }: { value: CatalogSearch; facets: CatalogFacets; onChange: (value: CatalogSearch) => void }) {
  const id = useId();
  const [draft, setDraft] = useState(value.search);
  const packs = facets.packs.filter((item) => !value.provider || item.provider === value.provider);
  return <form className="shop-catalog-filters" onSubmit={(event) => { event.preventDefault(); onChange({ ...value, search: draft.trim() }); }}>
    <div><label htmlFor={`${id}-search`}>{content.searchLabel}</label><div className="shop-catalog-search"><input id={`${id}-search`} type="search" value={draft} onChange={(event) => setDraft(event.target.value)} /><button type="submit" className="secondary">{content.search}</button></div></div>
    <div><label htmlFor={`${id}-provider`}>{content.providerLabel}</label><select id={`${id}-provider`} value={value.provider} onChange={(event) => onChange({ ...value, provider: event.target.value, packKey: '' })}>
      <option value="">{content.allProviders}</option>{facets.providers.map((provider) => <option key={provider} value={provider}>{content.providerNames[provider as keyof typeof content.providerNames] ?? provider}</option>)}
    </select></div>
    <div><label htmlFor={`${id}-pack`}>{content.packLabel}</label><select id={`${id}-pack`} value={value.packKey} onChange={(event) => onChange({ ...value, packKey: event.target.value })}>
      <option value="">{content.allPacks}</option>{packs.map((pack) => <option key={`${pack.provider}/${pack.key}`} value={pack.key}>{pack.name || pack.key.replace(/[-_]+/g, ' ')}</option>)}
    </select></div>
  </form>;
}
