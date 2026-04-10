"""
Stock Data Formatter Module

This module provides formatting functions for stock data responses.
"""

from typing import Any, Dict, Optional
from datetime import datetime


def format_data(data: Dict[str, Any], symbol: str, date: Optional[str] = None) -> str:
    """
    Format stock data into a readable text response.
    
    Args:
        data: Stock data dictionary from API
        symbol: Stock symbol
        date: Optional date for historical data
    
    Returns:
        Formatted text string with stock information
    """
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    
    if date:
        # Format historical closing price response using EOD data
        close_price = data.get('close', 'N/A')
        high = data.get('high', 'N/A')
        low = data.get('low', 'N/A')
        open_price = data.get('open', 'N/A')
        volume = data.get('volume', 'N/A')
        actual_date = data.get('datetime', date)
            
        return (
            f"Stock Historical Data (EOD): {symbol}\n"
            f"{'=' * 40}\n"
            f"Date: {actual_date}\n"
            f"Opening Price: ${open_price}\n"
            f"Closing Price: ${close_price}\n"
            f"Day High: ${high}\n"
            f"Day Low: ${low}\n"
            f"Volume: {volume}\n"
            f"Retrieved at: {timestamp}\n"
        )
    else:
        # Format current price response with change information
        # TwelveData quote endpoint returns comprehensive data
        price = data.get('close', data.get('price', 'N/A'))
        change = data.get('change', 0)
        percent_change = data.get('percent_change', 0)
        
        # Determine direction indicator
        if isinstance(change, (str, int, float)) and change != 'N/A':
            try:
                change_val = float(change)
                percent_val = float(percent_change)
                direction = "📈" if change_val >= 0 else "📉"
                change_str = f"{'+' if change_val >= 0 else ''}{change_val:.2f}"
                percent_str = f"{'+' if percent_val >= 0 else ''}{percent_val:.2f}%"
            except (ValueError, TypeError):
                direction = ""
                change_str = str(change)
                percent_str = str(percent_change)
        else:
            direction = ""
            change_str = "N/A"
            percent_str = "N/A"
        
        return (
            f"Stock Price Data: {symbol}\n"
            f"{'=' * 40}\n"
            f"Current Price: ${price}\n"
            f"Change: {change_str} ({percent_str}) {direction}\n"
            f"Previous Close: ${data.get('previous_close', 'N/A')}\n"
            f"Day High: ${data.get('high', 'N/A')}\n"
            f"Day Low: ${data.get('low', 'N/A')}\n"
            f"Volume: {data.get('volume', 'N/A')}\n"
            f"Exchange: {data.get('exchange', 'N/A')}\n"
            f"Retrieved at: {timestamp}\n"
        )