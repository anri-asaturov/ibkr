import isEmpty from 'lodash/isEmpty';
import { getRadomReqId } from '../_utils/text.utils';
import { ORDER, OrderState, CreateSale, OrderWithContract, OrderStatus } from './orders.interfaces';

import { publishDataToTopic, IbkrEvents, IBKREVENTS } from '../events';
import IBKRConnection from '../connection/IBKRConnection';
import { OrderStock } from './orders.interfaces';

import { Portfolios } from '../portfolios';
import { onConnected } from '../connection';
import { log, verbose } from '../log';

const ibkrEvents = IbkrEvents.Instance;


// Place Order + Cancel Order
// Get Filled open orders


interface SymbolTickerOrder {
    tickerId: number;
    orderPermId: number; // for reference when closing it
    symbol: string;
    stockOrderRequest: OrderStock
}

export class Orders {

    ib: any = null;

    // StockOrders
    tickerId = getRadomReqId();
    stockOrders: OrderStock[] = [];
    symbolsTickerOrder: { [x: string]: SymbolTickerOrder } = {}

    // OPEN ORDERS
    public openOrders: { [x: string]: OrderWithContract } = {};
    public receivedOrders: boolean = false;

    private static _instance: Orders;

    public static get Instance() {
        return this._instance || (this._instance = new this());
    }

    private constructor() {
        const self = this;

        // only when connected createSale
        ibkrEvents.on(IBKREVENTS.CONNECTED, async (sale: CreateSale) => {
            self.init();
        });

        ibkrEvents.emit(IBKREVENTS.PING); // ping connection
    }

    /**
     * init
     */
    public init = async (): Promise<void> => {
        let self = this;

        if (!self.ib) {
            const ib = IBKRConnection.Instance.getIBKR();
            self.ib = ib;


            ib.on('openOrderEnd', () => {
                verbose(`Orders > init > openOrderEnd`,` ->>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>`);
                // Initialise OrderTrader
                // OrderTrade.Instance.init();

                const openOrders = Object.keys(self.openOrders).map(key => self.openOrders[key]);

                publishDataToTopic({
                    topic: IBKREVENTS.OPEN_ORDERS,
                    data: openOrders,
                });

            })

            ib.on('orderStatus', (id, status, filled, remaining, avgFillPrice, permId,
                parentId, lastFillPrice, clientId, whyHeld) => {

                const currentOrder = self.openOrders[id];

                const orderStatus: OrderStatus = {
                    status, filled, remaining, avgFillPrice, permId,
                    parentId, lastFillPrice, clientId, whyHeld
                }

                publishDataToTopic({
                    topic: IBKREVENTS.ORDER_STATUS, //push to topic below,
                    data: {
                        order: currentOrder,
                        orderStatus
                    }
                });

                log(`Orders > orderStatus`, {
                    id,
                    status,
                    filled,
                    remaining,
                    symbol: currentOrder && currentOrder.symbol
                })
            });

            ib.on('openOrder', function (orderId, contract, order: ORDER, orderState: OrderState) {
                log(`Order> openOrder`, ` -> ${contract.symbol} ${order.action} ${order.totalQuantity}  ${orderState.status}`);


                // 1. Update OpenOrders
                // Orders that need to be filled
                // -----------------------------------------------------------------------------------
                self.receivedOrders = true;

                let openOrders = self.openOrders;

                self.openOrders = {
                    ...openOrders,
                    [orderId]: {
                        ...(openOrders && openOrders[orderId] || null),

                        // OrderId + orderState
                        orderId,
                        orderState,

                        // Add order
                        ...order,
                        // Add contract
                        ...contract
                    }
                };
                //  Delete order from openOrders list
                if (orderState.status === "Filled") {
                    log(`Filled -----> DELETE FROM OPEN ORDERS -------> ${JSON.stringify(contract)}`);
                    delete self.openOrders[orderId];
                }

                const openOrdersArr = Object.keys(self.openOrders).map(key => self.openOrders[key]);
                log(`OPEN ORDERS ${openOrdersArr && openOrdersArr.length}`);
                // -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
                // -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------


                // 2. Update OrderStocks
                // Orders requests to send to transmit
                // Using ticker Ids
                // -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
                const allTickerOrder: SymbolTickerOrder[] = Object.keys(self.symbolsTickerOrder).map(key => self.symbolsTickerOrder[key]);

                const thisOrderTicker = allTickerOrder.find(tickerOrder => tickerOrder.tickerId === orderId);

                // Add permId to orderTickObject
                if (!isEmpty(thisOrderTicker)) {

                    // update this symbolTickerOrder
                    self.symbolsTickerOrder[thisOrderTicker.symbol] = {
                        ...(self.symbolsTickerOrder[thisOrderTicker.symbol] || null),
                        orderPermId: order.permId,
                        symbol: thisOrderTicker.symbol
                    };

                    const updatedSymbolTicker = self.symbolsTickerOrder[thisOrderTicker.symbol];

                    // create sale if order is filled
                    if (orderState.status === "Filled") {
                        // Order is filled we can record it
                        // Check if we can create new trade
                        // on if stockOrderRequest is present
                        // that.symbolsTickerOrder[thisOrderTicker.symbol]
                        if (!isEmpty(updatedSymbolTicker.stockOrderRequest)) {

                            const { stockOrderRequest } = updatedSymbolTicker;
                            const { exitTrade, exitParams, symbol, capital } = stockOrderRequest;

                            const dataSaleSymbolOrder: OrderWithContract = {
                                ...order,
                                ...contract,
                                orderState,
                                orderId
                            }

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

                                log(`AccountOrderStock.openOrder`, `FILLED, TO CREATE SALE -> ${contract.symbol} ${order.action} ${order.totalQuantity}  ${orderState.status}`);

                                return publishDataToTopic({
                                    topic: IBKREVENTS.ORDER_FILLED,
                                    data: { sale: newSale, order: dataSaleSymbolOrder }
                                })
                            }

                            log(`AccountOrderStock.openOrder`, `FILLED, but no sale created -> ${contract.symbol} ${order.action} ${order.totalQuantity}  ${orderState.status}`);

                            publishDataToTopic({
                                topic: IBKREVENTS.ORDER_FILLED,
                                data: { sale: null, order: dataSaleSymbolOrder }
                            })

                        }
                    }


                }




            });

            ib.on('nextValidId', (orderIdNext: number) => {

                self.tickerId = orderIdNext++;

                const currentOrders = this.stockOrders;

                if (isEmpty(currentOrders)) {
                    return log(`Stock Orders are empty`);
                }

                // get first in the list
                const stockOrder = this.stockOrders.shift();

                if (isEmpty(stockOrder)) {
                    return log(`First Stock Orders Item is empty`);
                }

                const tickerToUse = self.tickerId;
                const { symbol } = stockOrder;

                log(`Placing order for ... ${tickerToUse} ${symbol}`);

                // [symbol, reqId]
                const orderCommand: Function = ib.order[stockOrder.type];

                const args = stockOrder.parameters;

                if (isEmpty(args)) {
                    return Promise.reject(new Error(`Arguments cannot be null`))
                }

                // Just save tickerId and stockOrder
                self.symbolsTickerOrder[symbol] = {
                    ...(self.symbolsTickerOrder[symbol] || null),
                    tickerId: tickerToUse,
                    symbol,
                    stockOrderRequest: stockOrder // for reference when closing trade
                };

                setTimeout(() => {
                    // Place order
                    ib.placeOrder(self.tickerId, ib.contract.stock(stockOrder.symbol), orderCommand(stockOrder.action, ...args));

                    // request open orders
                    ib.reqAllOpenOrders(); // refresh orders

                    log(`nextValidId > placedOrder -> ${self.tickerId}`)
                }, 1000);


            });


            // placeOrder event
            ibkrEvents.on(IBKREVENTS.PLACE_ORDER, async ({ stockOrder }: { stockOrder: OrderStock }) => {
                return await self.placeOrder(stockOrder);
            })
        }

        return self.reqAllOpenOrders();
    }

    /**
     *  reqAllOpenOrders
     */
    public reqAllOpenOrders = (): void => {
        log(`Orders > reqAllOpenOrders `)
        if (this.ib) {
            this.ib.reqAllOpenOrders();
        }
    }

    public getOpenOrders = async (): Promise<OrderWithContract[]> => {

        const self = this;
        const reqAllOpenOrders = self.reqAllOpenOrders;

        const openOrders = self && self.openOrders || {};

        return new Promise((resolve, reject) => {

            // listen for account summary
            const handleOpenOrders = (ordersData) => {
                ibkrEvents.off(IBKREVENTS.OPEN_ORDERS, handleOpenOrders);
                resolve(ordersData);
            }

            if (!isEmpty(openOrders)) {
                const allopenOrders = Object.keys(openOrders).map(key => openOrders[key])
                return resolve(allopenOrders)
            }



            ibkrEvents.on(IBKREVENTS.OPEN_ORDERS, handleOpenOrders);
            reqAllOpenOrders(); // refresh orders


            // TIMEOUT after 5 seconds
            setTimeout(() => {
                handleOpenOrders([])
            }, 5000)
        })
    }

    public isActive = (): boolean => {
        return this.receivedOrders;
    }

    public placeOrder = async (stockOrder: OrderStock): Promise<any> => {

        let self = this;
        const { getOpenOrders } = self;

        return new Promise((resolve, reject) => {
            const { exitTrade } = stockOrder;

            async function placeOrderToIBKR() {
                log(`Place Order Request -> ${stockOrder.symbol.toLocaleUpperCase()} ${stockOrder.action} ${stockOrder.parameters[0]}`);

                if (isEmpty(stockOrder.symbol)) {
                    return Promise.reject(new Error("Please enter order"))
                }

                // TODO check if stock exist
                const checkExistingOrders = await getOpenOrders();

                log(`Existing orders are -> ${checkExistingOrders.map(i => i.symbol)}`);

                // 1. Check existing open orders
                if (!isEmpty(checkExistingOrders)) {
                    // check if we have the same order from here

                    const findMatchingAction = checkExistingOrders.filter(
                        exi => exi.action === stockOrder.action
                            && exi.symbol === stockOrder.symbol);

                    if (!isEmpty(findMatchingAction)) {
                        return log(`Order already exist for ${stockOrder.action}, ${findMatchingAction[0].symbol} ->  @${stockOrder.parameters[0]} ${findMatchingAction[0].orderState.status}`);
                    }
                }

                const checkExistingPositions = await Portfolios.Instance.getPortfolios();
                log(`Existing portfolios are -> ${JSON.stringify(checkExistingPositions.map(i => i.symbol))}`);

                // 2. Check existing portfolios
                const foundExistingPortfolios = checkExistingPositions.filter(
                    exi => exi.symbol === stockOrder.symbol);

                log(`foundExistingPortfolios are -> ${JSON.stringify(foundExistingPortfolios.map(i => i.symbol))}`);

                if (!isEmpty(checkExistingPositions)) {

                    // Only if this is not exit
                    if (!isEmpty(foundExistingPortfolios)) {

                        if (!exitTrade) {
                            return log(`*********************************Portfolio already exist and has position for ${stockOrder.action}, ${foundExistingPortfolios[0].symbol} ->  order@${stockOrder.parameters[0]} portfolio@${foundExistingPortfolios[0].position}`);
                        }
                        // Else existing trades are allowed
                    }

                }

                self.stockOrders.push(stockOrder);

                self.ib.reqIds(self.tickerId);

                setTimeout(() => {
                    log(`Order > placeOrder -> tickerId ${self.tickerId}`);
                    resolve({ tickerId: self.tickerId })
                }, 1000);

            }

            placeOrderToIBKR();


        })

    }
}

export default Orders;