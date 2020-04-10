import chalk from 'chalk';
import random from 'lodash/random';
import isEmpty from 'lodash/isEmpty';
import { getRadomReqId } from '../_utils/text.utils';
import { ORDER, OrderState, CreateSale } from './orders.interfaces';
import AccountOpenOrders from './OpenOrders';

import { publishDataToTopic, AppEvents, APPEVENTS } from '../events';
import IBKRConnection from '../connection/IBKRConnection';
import { OrderStock } from './orders.interfaces';
import OpenOrders from './OpenOrders';
import { Portfolios } from '../portfolios';

const appEvents = AppEvents.Instance;

// TODO
// Place Order + Cancel Order
// Get All open orders
// Buy/Sell stock
// Close order


interface SymbolTickerOrder {
    tickerId: number;
    orderPermId: number; // for reference when closing it
    symbol: string;
    stockOrderRequest: OrderStock
}

export class AccountOrderStock {

    ib: any;
    tickerId = getRadomReqId();

    symbolsTickerOrder: { [x: string]: SymbolTickerOrder } = {}

    orders: OrderStock[] = [];

    private static _instance: AccountOrderStock;

    public static get Instance() {
        return this._instance || (this._instance = new this());
    }

    private constructor() {

        const ib = IBKRConnection.Instance.getIBKR();
        this.ib = ib;
        let that = this;

        ib.on('openOrder', function (orderId, contract, order: ORDER, orderState: OrderState) {
            console.log(`AccountOrderStock.openOrder`, chalk.red(` -> ${contract.symbol} ${order.action} ${order.totalQuantity}  ${orderState.status}`));

            const allTickerOrder: SymbolTickerOrder[] = Object.keys(that.symbolsTickerOrder).map(key => that.symbolsTickerOrder[key]);

            const thisOrderTicker = allTickerOrder.find(tickerOrder => tickerOrder.tickerId === orderId);

            // Add permId to orderTickObject
            if (!isEmpty(thisOrderTicker)) {

                // update this symbolTickerOrder
                that.symbolsTickerOrder[thisOrderTicker.symbol] = {
                    ...(that.symbolsTickerOrder[thisOrderTicker.symbol] || null),
                    orderPermId: order.permId,
                    symbol: thisOrderTicker.symbol
                };

                const updatedSymbolTicker = that.symbolsTickerOrder[thisOrderTicker.symbol];

                // create sale if order is filled
                if (orderState.status === "Filled") {
                    // Order is filled we can record it
                    // Check if we can create new trade
                    // on if stockOrderRequest is present
                    // that.symbolsTickerOrder[thisOrderTicker.symbol]
                    if (!isEmpty(updatedSymbolTicker.stockOrderRequest)) {

                        const { stockOrderRequest } = updatedSymbolTicker;
                        const { exitTrade, exitParams, symbol, capital } = stockOrderRequest;

                        if (exitTrade) {
                            const { exitPrice, exitTime, entryTime, entryPrice } = exitParams;
                            // If this trade is for exiting then record the sale
                            // create sale now
                            const newSale: CreateSale = {
                                capital,
                                exitPrice,
                                exitTime,
                                entryTime,
                                entryPrice,
                                symbol,
                                profit: entryPrice - exitPrice
                            };

                            console.log(`AccountOrderStock.openOrder`, chalk.green(`FILLED, TO CREATE SALE -> ${contract.symbol} ${order.action} ${order.totalQuantity}  ${orderState.status}`));

                            publishDataToTopic({
                                topic: APPEVENTS.CREATE_SALE,
                                data: newSale
                            })
                        }
                        else {
                            console.log(`AccountOrderStock.openOrder`, chalk.green(`FILLED, but no sale created -> ${contract.symbol} ${order.action} ${order.totalQuantity}  ${orderState.status}`));
                        }

                    }
                }
            }




        });

        ib.on('nextValidId', (orderIdNext: number) => {

            that.tickerId = orderIdNext++;

            const currentOrders = this.orders;

            if (isEmpty(currentOrders)) {
                return console.log(chalk.red(`Stock Orders are empty`));
            }

            // get first in the list
            const stockOrder = this.orders.shift();

            if (isEmpty(stockOrder)) {
                return console.log(chalk.red(`First Stock Orders Item is empty`));
            }

            const tickerToUse = that.tickerId;
            const { symbol } = stockOrder;

            console.log(chalk.yellow(`Placing order for ... ${tickerToUse} ${symbol}`));

            // [symbol, reqId]
            const orderCommand: Function = ib.order[stockOrder.type];

            const args = stockOrder.parameters;

            if (isEmpty(args)) {
                return Promise.reject(new Error(`Arguments cannot be null`))
            }

            // Just save tickerId and stockOrder
            that.symbolsTickerOrder[symbol] = {
                ...(that.symbolsTickerOrder[symbol] || null),
                tickerId: tickerToUse,
                symbol,
                stockOrderRequest: stockOrder // for reference when closing trade
            };

            setTimeout(() => {
                // Place order
                ib.placeOrder(that.tickerId, ib.contract.stock(stockOrder.symbol), orderCommand(stockOrder.action, ...args));

                // request open orders
                ib.reqAllOpenOrders(); // refresh orders

                console.log(chalk.yellow(`ORDER:COMPLETE -> ${that.tickerId}`))
            }, 1000);


        });


        // placeOrder event
        appEvents.on(APPEVENTS.PLACE_ORDER, async ({ stockOrder }: { stockOrder: OrderStock }) => {
            return await that.placeOrder(stockOrder);
        })

        // createSale
        // appEvents.on(APPEVENTS.CREATE_SALE, async (sale: CreateSale) => {
        //     return await createSaleToCloud(sale);
        // });

        // appEvents.on('deletePortfolio', async ({ symbol }) => {
        //     return await deletePortfolio(symbol);
        // });

    }

    async placeOrder(stockOrder: OrderStock): Promise<any> {

        let that = this;

        return new Promise((resolve, reject) => {
            const { exitTrade } = stockOrder;

            async function placeOrderToIBKR() {
                console.log(chalk.magentaBright(`Place Order Request -> ${stockOrder.symbol.toLocaleUpperCase()} ${stockOrder.action} ${stockOrder.parameters[0]}`))

                if (isEmpty(stockOrder.symbol)) {
                    return Promise.reject(new Error("Please enter order"))
                }

                // TODO check if stock exist
                const checkExistingOrders = OpenOrders.Instance.getOpenOrders();

                console.log(chalk.red(`Existing orders are -> ${checkExistingOrders.map(i => i.symbol)}`))

                // Check existing open orders
                if (!isEmpty(checkExistingOrders)) {
                    // check if we have it from here
                    const findMatchingAction = checkExistingOrders.filter(
                        exi => exi.action === stockOrder.action
                            && exi.symbol === stockOrder.symbol);

                    if (!isEmpty(findMatchingAction)) {

                        // No need to check status
                        return console.log(chalk.red(`Order already exist for ${stockOrder.action}, ${findMatchingAction[0].symbol} ->  @${stockOrder.parameters[0]} ${findMatchingAction[0].orderState.status}`))

                        // check status
                        // const statuses = findMatchingAction.map(i => i.orderState.status);

                        // const prohibitedStatuses = ["PreSubmitted", "Submitted", "Filled"];
                        // const allFounded = prohibitedStatuses.every((ai: any) => statuses.includes(ai));

                        // if (allFounded) {
                        // }

                    }
                }

                const checkExistingPositions = Portfolios.Instance.getPortfolios();
                console.log(chalk.red(`Existing portfolios are -> ${JSON.stringify(checkExistingPositions.map(i => i.contract.symbol))}`));

                // Check existing portfolios
                const foundExistingPortfolios = checkExistingPositions.filter(
                    exi => exi.contract.symbol === stockOrder.symbol);

                console.log(chalk.red(`foundExistingPortfolios are -> ${JSON.stringify(foundExistingPortfolios.map(i => i.contract.symbol))}`));

                if (!isEmpty(checkExistingPositions)) {

                    // Only if this is not exit
                    if (!isEmpty(foundExistingPortfolios)) {

                        if (!exitTrade) {
                            return console.log(chalk.magenta(`*********************************Portfolio already exist and has position for ${stockOrder.action}, ${foundExistingPortfolios[0].contract.symbol} ->  order@${stockOrder.parameters[0]} portfolio@${foundExistingPortfolios[0].position}`))
                        }

                        // Else existing trades are allowed

                    }

                }

                this.orders.push(stockOrder);

                setTimeout(() => {
                    console.log(chalk.red(`setTimeout: ReqIds -> ${that.tickerId}`))
                    ib.reqIds(that.tickerId);
                    resolve({ tickerId: that.tickerId })
                }, 1000);

            }


        })

    }
}