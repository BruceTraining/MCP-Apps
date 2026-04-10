#!/usr/bin/env python3
"""
Stock MCP Server - A Model Context Protocol server that provides stock price information.

This server implements:
- Stock price resources accessible via URIs (stock://SYMBOL/)
- Historical closing prices via URIs (stock://SYMBOL/closingdate/YYYY-MM-DD)
- MCP tool functions for better client compatibility
- STDIO transport for communication
- Integration with Twelve Data API for real-time and historical stock data

Built using FastMCP from the official MCP Python SDK.
"""

import sys
import traceback
from typing import Any, Dict, Optional
from datetime import datetime

from fastmcp import FastMCP
from twelvedata import TDClient
import os
from dotenv import load_dotenv

# Import the formatting function from our separate module
from .stock_formatter import format_data

# Helper function for logging to stderr (doesn't interfere with STDIO transport)
def log(message: str):
    """Log message to stderr to avoid interfering with STDIO transport."""
    sys.stderr.write(f"{message}\n")
    sys.stderr.flush()

# Load environment variables
load_dotenv()

# Get API key from environment
api_key = os.getenv('TWELVE_DATA_API_KEY')
if not api_key:
    raise ValueError("TWELVE_DATA_API_KEY environment variable is required")

# Initialize the TwelveData client
twelve_data_client = TDClient(apikey=api_key)

# Create the FastMCP server instance
mcp = FastMCP("stock-mcp")

# ==========================================
# INTERNAL/SHARED FUNCTIONS
# ==========================================

def _fetch_current_stock_price(symbol: str) -> str:
    """
    Internal function to fetch current stock price with change information.
    
    This function is called by both the MCP resource and MCP tool to ensure
    consistency and reduce code duplication.
    
    Args:
        symbol: Stock symbol (e.g., 'AAPL', 'MSFT', 'GOOGL')
    
    Returns:
        Formatted string with current price and change data
    """
    log(f"Fetching current price for {symbol}")
    
    try:
        # Use the quote endpoint for comprehensive current data
        quote_data = twelve_data_client.quote(symbol=symbol.upper()).as_json()
        
        # Format and return the response using our imported function
        return format_data(quote_data, symbol.upper())
        
    except Exception as e:
        error_msg = f"Error fetching stock data for {symbol}: {str(e)}"
        log(error_msg)
        log(traceback.format_exc())
        return f"Error: {error_msg}"


def _fetch_historical_stock_price(symbol: str, date: str) -> str:
    """
    Internal function to fetch historical closing price for a specific date.
    
    This function is called by both the MCP resource and MCP tool to ensure
    consistency and reduce code duplication.
    
    Args:
        symbol: Stock symbol (e.g., 'AAPL', 'MSFT', 'GOOGL')
        date: Date in YYYY-MM-DD format
    
    Returns:
        Formatted string with historical closing price data
    """
    log(f"Fetching EOD data for {symbol} on {date}")
    
    # Validate date format
    try:
        date_obj = datetime.strptime(date, '%Y-%m-%d')
        # Check if the date is a weekend (markets are closed)
        if date_obj.weekday() >= 5:  # Saturday = 5, Sunday = 6
            return f"Warning: {date} is a weekend. Stock markets are typically closed. Try a weekday date."
    except ValueError:
        return f"Error: Invalid date format '{date}'. Use YYYY-MM-DD"
    
    try:
        # Use the EOD (End of Day) endpoint for historical closing price data
        # This is specifically designed for getting historical end-of-day data
        eod_data = twelve_data_client.eod(
            symbol=symbol.upper(),
            date=date
        ).as_json()
        
        # Check if we got valid data from EOD endpoint
        if not eod_data:
            return f"Error: No EOD data returned for {symbol} on {date}"
        
        # Check for API error in response
        if 'status' in eod_data and eod_data['status'] == 'error':
            error_msg = eod_data.get('message', 'Unknown API error')
            return f"API Error: {error_msg}"
        
        # Check if the response indicates no data available
        if 'code' in eod_data and eod_data['code'] == 400:
            error_msg = eod_data.get('message', 'No data available for this date')
            return f"No data available: {error_msg}"
        
        # Check if we have the required closing price data
        if 'close' not in eod_data or eod_data['close'] is None:
            return f"No closing price data available for {symbol} on {date}. Markets may have been closed."
        
        # Format and return the response using our imported function
        return format_data(eod_data, symbol.upper(), date)
        
    except Exception as e:
        error_msg = f"Error fetching EOD data for {symbol} on {date}: {str(e)}"
        log(error_msg)
        log(traceback.format_exc())
        return f"Error: {error_msg}"


# ==========================================
# MCP PROMPTS 
# ==========================================

@mcp.prompt("stock_current_price")
def stock_current_price_prompt(symbol: str) -> str:
    """
    Prompt for getting current stock price information.
    
    This prompt helps MCP clients understand how to request current stock data
    for any publicly traded stock symbol.
    
    Args:
        symbol: Stock symbol (e.g., 'AAPL', 'GOOGL', 'MSFT')
    
    Returns:
        Instructions for accessing current stock price data
    """
    return f"""
To get current stock price information for {symbol.upper()}:

Use the resource: stock://{symbol.upper()}/
Or use the tool: get_current_stock_price with symbol parameter

This will provide you with:
- Current stock price
- Price change from previous close
- Percentage change
- Day's high and low prices
- Trading volume
- Exchange information

Example usage:
- For Apple stock: stock://AAPL/ or get_current_stock_price(symbol="AAPL")
- For Microsoft stock: stock://MSFT/ or get_current_stock_price(symbol="MSFT")
- For Google stock: stock://GOOGL/ or get_current_stock_price(symbol="GOOGL")

The data is fetched in real-time from the Twelve Data API and includes
comprehensive market information with change indicators.
"""


@mcp.prompt("stock_historical_price")
def stock_historical_price_prompt(symbol: str, date: str) -> str:
    """
    Prompt for getting historical stock price information for a specific date.
    
    This prompt helps MCP clients understand how to request historical End-of-Day
    stock data for any publicly traded stock symbol on a specific date.
    
    Args:
        symbol: Stock symbol (e.g., 'AAPL', 'GOOGL', 'MSFT')
        date: Date in YYYY-MM-DD format
    
    Returns:
        Instructions for accessing historical stock price data
    """
    return f"""
To get historical End-of-Day (EOD) stock price information for {symbol.upper()} on {date}:

Use the resource: stock://{symbol.upper()}/closingdate/{date}
Or use the tool: get_historical_stock_price with symbol and date parameters

This will provide you with:
- Opening price for the day
- Closing price for the day
- Day's high and low prices
- Trading volume
- Actual date of the data

Example usage:
- For Apple stock on Jan 15, 2024: stock://AAPL/closingdate/2024-01-15 or get_historical_stock_price(symbol="AAPL", date="2024-01-15")
- For Microsoft stock on Dec 31, 2023: stock://MSFT/closingdate/2023-12-31 or get_historical_stock_price(symbol="MSFT", date="2023-12-31")

Important notes:
- Date must be in YYYY-MM-DD format
- Weekend dates will return a warning (markets are typically closed)
- Historical data is sourced from Twelve Data's EOD endpoint
- Data may not be available for very recent dates or market holidays
"""


@mcp.prompt("stock_usage_guide")
def stock_usage_guide_prompt() -> str:
    """
    General usage guide for the Stock MCP Server.
    
    This prompt provides comprehensive instructions on how to use all available
    stock resources and tools and their expected formats.
    
    Returns:
        Complete usage guide for the Stock MCP Server
    """
    return """
        Stock MCP Server Usage Guide
        ============================

        This server provides resources and tools for stock market data:

        1. CURRENT STOCK PRICES
        Resource Pattern: stock://{SYMBOL}/
        Tool: get_current_stock_price(symbol)
        
        Examples:
        - stock://AAPL/     (Apple Inc.) or get_current_stock_price(symbol="AAPL")
        - stock://MSFT/     (Microsoft Corporation) or get_current_stock_price(symbol="MSFT")
        - stock://GOOGL/    (Alphabet Inc.) or get_current_stock_price(symbol="GOOGL")
        - stock://TSLA/     (Tesla Inc.) or get_current_stock_price(symbol="TSLA")
        - stock://NVDA/     (NVIDIA Corporation) or get_current_stock_price(symbol="NVDA")
        
        Returns: Current price, change, percentage change, day high/low, volume, exchange

        2. HISTORICAL STOCK PRICES (End-of-Day Data)
        Resource Pattern: stock://{SYMBOL}/closingdate/{YYYY-MM-DD}
        Tool: get_historical_stock_price(symbol, date)
        
        Examples:
        - stock://AAPL/closingdate/2024-01-15 or get_historical_stock_price(symbol="AAPL", date="2024-01-15")
        - stock://MSFT/closingdate/2023-12-31 or get_historical_stock_price(symbol="MSFT", date="2023-12-31")
        - stock://GOOGL/closingdate/2024-03-01 or get_historical_stock_price(symbol="GOOGL", date="2024-03-01")
        
        Returns: Open, close, high, low prices and volume for the specified date

        SYMBOL REQUIREMENTS:
        - Use standard stock ticker symbols (typically 1-5 characters)
        - Symbols are case-insensitive (AAPL = aapl = Aapl)
        - Must be valid symbols traded on supported exchanges

        DATE REQUIREMENTS:
        - Format: YYYY-MM-DD (e.g., 2024-01-15)
        - Weekends will return warnings as markets are typically closed
        - Very recent dates may not have data available yet
        - Historical data availability depends on the stock and exchange

        ERROR HANDLING:
        - Invalid symbols will return error messages
        - Invalid date formats will be rejected
        - Missing data scenarios are handled gracefully

        DATA SOURCE:
        - All data is sourced from the Twelve Data API
        - Real-time quotes for current prices
        - End-of-Day (EOD) data for historical prices
        """


# ==========================================
# MCP RESOURCES 
# ==========================================

@mcp.resource("stock://{symbol}")
def get_stock_price(symbol: str) -> str:
    """
    Get current stock price with change information.
    
    This resource provides real-time stock data for any valid symbol.
    Access via: stock://SYMBOL/
    
    Args:
        symbol: Stock symbol (e.g., 'AAPL', 'MSFT')
    
    Returns:
        Formatted string with current price and change data
    """
    log(f"Resource call: stock://{symbol}")
    return _fetch_current_stock_price(symbol)


@mcp.resource("stock://{symbol}/closingdate/{date}")
def get_stock_closing_price(symbol: str, date: str) -> str:
    """
    Get historical closing price for a specific date using EOD (End of Day) data.
    
    This resource provides historical stock data for a given date.
    Access via: stock://SYMBOL/closingdate/YYYY-MM-DD
    
    Args:
        symbol: Stock symbol (e.g., 'AAPL', 'MSFT')
        date: Date in YYYY-MM-DD format
    
    Returns:
        Formatted string with closing price data
    """
    log(f"Resource call: stock://{symbol}/closingdate/{date}")
    return _fetch_historical_stock_price(symbol, date)


# ==========================================
# MCP TOOLS 
# ==========================================

@mcp.tool()
def get_current_stock_price(symbol: str) -> str:
    """
    Get current stock price with change information using MCP tool interface.
    
    This tool provides real-time stock data for any valid symbol and calls
    the underlying resource function for consistency.
    
    Args:
        symbol: Stock symbol (e.g., 'AAPL', 'MSFT', 'GOOGL')
    
    Returns:
        Formatted string with current price and change data
    """
    log(f"Tool call: get_current_stock_price for {symbol}")
    return _fetch_current_stock_price(symbol)


@mcp.tool()
def get_historical_stock_price(symbol: str, date: str) -> str:
    """
    Get historical closing price for a specific date using MCP tool interface.
    
    This tool provides historical stock data for a given date and calls
    the underlying resource function for consistency.
    
    Args:
        symbol: Stock symbol (e.g., 'AAPL', 'MSFT', 'GOOGL')
        date: Date in YYYY-MM-DD format (e.g., '2024-01-15')
    
    Returns:
        Formatted string with historical closing price data
    """
    log(f"Tool call: get_historical_stock_price for {symbol} on {date}")
    return _fetch_historical_stock_price(symbol, date)



def main():
    """
    Main entry point for the Stock MCP Server.
    
    Starts the server with STDIO transport.
    """
    try:
        log(
        """Starting Stock MCP Server
        Resources available:
        - stock://{symbol} - Get current stock price
        - stock://{symbol}/closingdate/{date} - Get historical closing price (EOD)
        Tools available:
        - get_current_stock_price(symbol) - Get current stock price
        - get_historical_stock_price(symbol, date) - Get historical closing price
        - get_multiple_stock_prices(symbols) - Get multiple current stock prices
        Prompts available:
        - stock_current_price - Guide for current stock prices
        - stock_historical_price - Guide for historical stock prices
        - stock_usage_guide - Complete usage instructions""")
        
        # Run the FastMCP server with STDIO transport
        mcp.run()
    except KeyboardInterrupt:
        log("Server shutdown requested by user")
    except Exception as e:
        log(f"Failed to start Stock MCP Server: {e}")
        log(traceback.format_exc())
        sys.exit(1)


if __name__ == "__main__":
    # Run the main function
    main()