package httpapi

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/wookiisky/check-in-suite/internal/character"
	"github.com/wookiisky/check-in-suite/internal/island"
	"github.com/wookiisky/check-in-suite/internal/shop"
	"github.com/wookiisky/check-in-suite/internal/wallet"
)

// TestDevelopmentBuyAll verifies the real route gate, durable ownership and retry behavior.
func TestDevelopmentBuyAll(t *testing.T) {
	app, request := shopHTTPRequest(t)
	const buyAll = "/api/v1/shop/development/buy-all"
	const catalog = "/api/v1/shop/products?group=camp&limit=1"

	read := func() shop.ShopPage {
		t.Helper()
		response := request("GET", catalog, "", "")
		var page shop.ShopPage
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &page) != nil {
			t.Fatalf("browse=%d %s", response.Code, response.Body)
		}
		return page
	}
	if read().DevelopmentBuyAll {
		t.Fatal("default environment enabled the development action")
	}
	if response := request("POST", buyAll, "", ""); response.Code != http.StatusNotFound {
		t.Fatalf("default environment response=%d %s", response.Code, response.Body)
	}
	app.Config.Development = true
	if response := apiRequest(app, "POST", buyAll, "", nil, ""); response.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous response=%d %s", response.Code, response.Body)
	}

	create := func(input shop.ProductCreate) shop.Product {
		t.Helper()
		body, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		response := request("POST", "/api/v1/management/products", string(body), input.Name)
		var product shop.Product
		if response.Code != http.StatusCreated || json.Unmarshal(response.Body.Bytes(), &product) != nil {
			t.Fatalf("create=%d %s", response.Code, response.Body)
		}
		return product
	}
	var items []island.SpatialDefinition
	for _, item := range island.SpatialCatalog() {
		if item.Category == "furniture" && item.Repeatable {
			items = append(items, item)
		}
	}
	if len(items) < 3 {
		t.Fatal("fixture needs three repeatable furniture items")
	}
	stock := int64(0)
	input := shop.ProductCreate{AssetKey: items[0].ThumbnailAssetKey, ProductTerms: shop.ProductTerms{Name: "开发商品一", Enabled: true, CoinPrice: 20, DiamondPrice: 2, Stock: &stock}}
	first := create(input)
	input.Name = "开发商品一的另一报价"
	create(input)
	input.Name, input.AssetKey = "开发商品二", items[1].ThumbnailAssetKey
	create(input)
	input.Name, input.AssetKey, input.Enabled = "下架商品", items[2].ThumbnailAssetKey, false
	create(input)
	var body character.Definition
	for _, item := range character.Definitions() {
		if item.Key != character.DefaultCharacterKey {
			body = item
			break
		}
	}
	if body.Key == "" {
		t.Fatal("fixture needs a paid character")
	}
	create(shop.ProductCreate{AssetKey: body.ThumbnailAssetKey, ProductTerms: shop.ProductTerms{Name: body.Name, Enabled: true}})

	before := read()
	if !before.DevelopmentBuyAll || before.Total != 3 || len(before.Items) != 1 {
		t.Fatalf("before=%+v", before)
	}
	if _, err := app.DB.Exec(`CREATE TRIGGER fail_second_development_order BEFORE INSERT ON purchases
		WHEN (SELECT count(*) FROM purchases)=1 BEGIN SELECT RAISE(ABORT, 'test failure'); END`); err != nil {
		t.Fatal(err)
	}
	if response := request("POST", buyAll, "", ""); response.Code != http.StatusInternalServerError {
		t.Fatalf("failed grant=%d %s", response.Code, response.Body)
	}
	if failed := read(); failed.Total != before.Total || failed.Wallet != before.Wallet {
		t.Fatalf("failed grant left changes: %+v", failed)
	}
	if _, err := app.DB.Exec("DROP TRIGGER fail_second_development_order"); err != nil {
		t.Fatal(err)
	}

	login := apiRequest(app, "POST", "/api/v1/auth/login", `{"username":"family","password":"login-password"}`, nil, "")
	var session struct {
		CSRF string `json:"csrf_token"` // Token for the regular, still locked login.
	}
	if login.Code != http.StatusOK || json.Unmarshal(login.Body.Bytes(), &session) != nil {
		t.Fatalf("login=%d %s", login.Code, login.Body)
	}
	cookie := login.Result().Cookies()[0]
	if response := apiRequest(app, "POST", buyAll, "", cookie, ""); response.Code != http.StatusForbidden {
		t.Fatalf("no CSRF response=%d %s", response.Code, response.Body)
	}
	readReceipt := func(response *httptest.ResponseRecorder) wallet.Balance {
		t.Helper()
		var balance wallet.Balance
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &balance) != nil {
			t.Fatalf("buy all=%d %s", response.Code, response.Body)
		}
		return balance
	}
	responses := make(chan *httptest.ResponseRecorder, 2)
	start := make(chan struct{})
	for range 2 {
		go func() {
			<-start
			responses <- apiRequest(app, "POST", buyAll, "", cookie, session.CSRF)
		}()
	}
	close(start)
	after := readReceipt(<-responses)
	if after.Coins != before.Wallet.Coins || after.Diamonds != before.Wallet.Diamonds || after.Version != before.Wallet.Version+3 {
		t.Fatalf("balance before=%+v after=%+v", before.Wallet, after)
	}
	if concurrent := readReceipt(<-responses); concurrent != after {
		t.Fatalf("concurrent=%+v after=%+v", concurrent, after)
	}
	if retry := readReceipt(apiRequest(app, "POST", buyAll, "", cookie, session.CSRF)); retry != after {
		t.Fatalf("retry=%+v after=%+v", retry, after)
	}
	if page := read(); page.Total != 0 || page.Wallet != after {
		t.Fatalf("after=%+v", page)
	}

	var count, zeroPrice, characters, version int64
	var finalStock sql.NullInt64
	if err := app.DB.QueryRow("SELECT count(*),sum(coin_price=0 AND diamond_price=0),sum(character_key_snapshot=?) FROM purchases", body.Key).Scan(&count, &zeroPrice, &characters); err != nil || count != 3 || zeroPrice != 3 || characters != 1 {
		t.Fatalf("count=%d zero price=%d characters=%d err=%v", count, zeroPrice, characters, err)
	}
	if err := app.DB.QueryRow("SELECT stock,version FROM products WHERE id=?", first.ID).Scan(&finalStock, &version); err != nil || !finalStock.Valid || finalStock.Int64 != stock || version != first.Version {
		t.Fatalf("stock=%+v version=%d err=%v", finalStock, version, err)
	}
}
