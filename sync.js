var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (_) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var _this = this;
require('dotenv').config();
var _a = require('fs'), writeFileSync = _a.writeFileSync, readFileSync = _a.readFileSync;
var join = require('path').join;
var ynab = require('ynab');
var getRefreshToken = function () {
    var value = readFileSync(join(__dirname, './refreshToken.txt'), 'utf-8');
    return value;
};
var getLastSyncDate = function () {
    var value = readFileSync(join(__dirname, './lastSyncDate.txt'), 'utf-8');
    return value;
};
var saveRefreshToken = function (value) {
    writeFileSync(join(__dirname, './refreshToken.txt'), value);
};
var saveLastSyncDate = function (value) {
    writeFileSync(join(__dirname, './lastSyncDate.txt'), value);
};
var fetchToken = function (refreshToken, clientId, clientSecret) { return __awaiter(_this, void 0, void 0, function () {
    var body, response, json;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                body = new URLSearchParams({
                    client_id: clientId,
                    client_secret: clientSecret,
                    refresh_token: refreshToken,
                    grant_type: 'refresh_token'
                });
                return [4 /*yield*/, fetch('https://api-auth.sparebank1.no/oauth/token', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded'
                        },
                        body: body
                    })];
            case 1:
                response = _a.sent();
                return [4 /*yield*/, response.json()];
            case 2:
                json = _a.sent();
                return [2 /*return*/, json];
        }
    });
}); };
var fetchBankTransactions = function (accessToken, accountKey, fromDate) { return __awaiter(_this, void 0, void 0, function () {
    var transactionsResponse, transactions;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, fetch('https://api.sparebank1.no/personal/banking/transactions?' +
                    new URLSearchParams({ accountKey: accountKey, fromDate: fromDate }), {
                    headers: {
                        Authorization: "Bearer ".concat(accessToken),
                        Accept: 'application/vnd.sparebank1.v1+json;charset=utf-8'
                    }
                })];
            case 1:
                transactionsResponse = _a.sent();
                return [4 /*yield*/, transactionsResponse.json()];
            case 2:
                transactions = _a.sent();
                return [2 /*return*/, transactions];
        }
    });
}); };
// main program
var main = function () { return __awaiter(_this, void 0, void 0, function () {
    var refreshToken, _a, accessToken, newRefreshToken, lastSyncDate, today, transactions, ynabAPI;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                refreshToken = getRefreshToken();
                return [4 /*yield*/, fetchToken(refreshToken, process.env.BANK_CLIENT_ID, process.env.BANK_CLIENT_SECRET)];
            case 1:
                _a = _b.sent(), accessToken = _a.access_token, newRefreshToken = _a.refresh_token;
                saveRefreshToken(newRefreshToken);
                try {
                    lastSyncDate = getLastSyncDate();
                }
                catch (e) {
                    today = new Date();
                    lastSyncDate = today.toISOString().split('T')[0];
                }
                return [4 /*yield*/, fetchBankTransactions(accessToken, process.env.BANK_ACCOUNT_KEY, lastSyncDate)];
            case 2:
                transactions = _b.sent();
                console.log('transactions', transactions);
                ynabAPI = new ynab.API(process.env.YNAB_TOKEN);
                // ynabAPI.transactions.createTransactions(process.env.YNAB_BUDGET_ID, {
                //   transactions: ynabTransactions,
                // });
                // ynabAPI.transactions.getTransactions(process.env.YNAB_BUDGET_ID, lastSyncDate).then((data) => {
                //   console.log('data', data.data.transactions);
                // });
                saveLastSyncDate(lastSyncDate);
                return [2 /*return*/];
        }
    });
}); };
main();
