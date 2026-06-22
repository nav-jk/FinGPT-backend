import YahooFinance from 'yahoo-finance2';

const yahooFinance = new YahooFinance();

/**
 * Resolve company name -> ticker
 */
async function getTicker(companyName) {
    const results = await yahooFinance.search(companyName);

    if (!results.quotes || results.quotes.length === 0) {
        throw new Error(`No ticker found for ${companyName}`);
    }

    const bestMatch = results.quotes[0];

    return {
        ticker: bestMatch.symbol,
        companyName: bestMatch.shortname || bestMatch.longname
    };
}

/**
 * Fetch chart data for a period
 */
async function getChartData(ticker, days) {
    const endDate = new Date();

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const chart = await yahooFinance.chart(ticker, {
        period1: startDate,
        period2: endDate,
        interval: '1d'
    });

    return chart.quotes.map(point => ({
        date: point.date,
        open: point.open,
        high: point.high,
        low: point.low,
        close: point.close,
        volume: point.volume
    }));
}

/**
 * Main function
 */
export async function getCompanyChart(companyName) {
    const { ticker, companyName: resolvedName } =
        await getTicker(companyName);

    const [tenDay, fifteenDay, thirtyDay] =
        await Promise.all([
            getChartData(ticker, 10),
            getChartData(ticker, 15),
            getChartData(ticker, 30)
        ]);

    return {
        companyName: resolvedName,
        ticker,

        chartData: {
            tenDay,
            fifteenDay,
            thirtyDay
        }
    };
}