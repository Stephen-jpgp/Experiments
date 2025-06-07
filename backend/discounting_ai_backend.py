import asyncio
import websockets
import json
import base64
import time
import logging
import uuid
from typing import Dict, List, Optional
from dataclasses import dataclass, asdict
from collections import deque
import numpy as np
from datetime import datetime
import aioredis
import asyncpg

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@dataclass
class Frame:
    session_id: str
    frame_id: int
    timestamp: float
    data: str  # Base64 encoded image
    viewport: Dict
    url: str
    events: List[Dict]
    processing_status: str = "pending"
    intent_score: float = 0.0
    processed_at: Optional[float] = None

@dataclass
class Session:
    session_id: str
    user_id: Optional[str]
    website_domain: str
    start_time: float
    last_activity: float
    frame_count: int = 0
    total_intent_score: float = 0.0
    current_state: str = "browsing"
    frame_history: deque = None
    discount_triggers: List = None

    def __post_init__(self):
        if self.frame_history is None:
            self.frame_history = deque(maxlen=100)  # Keep last 100 frames (20 seconds at 5fps)
        if self.discount_triggers is None:
            self.discount_triggers = []

@dataclass
class DiscountTrigger:
    trigger_type: str
    discount_percentage: int
    confidence: float
    reasoning: str
    timestamp: float
    session_id: str

class FrameProcessor:
    """Handles frame processing and AI analysis"""
    
    def __init__(self):
        self.processing_queue = asyncio.Queue()
        self.cv_api_semaphore = asyncio.Semaphore(5)  # Limit concurrent API calls
        
    async def process_frame(self, frame: Frame) -> Frame:
        """Process a single frame through AI pipeline"""
        try:
            # Add basic processing timestamp
            frame.processed_at = time.time()
            frame.processing_status = "processing"
            
            # TODO: Add computer vision processing here
            # For now, simulate processing with basic analysis
            frame.intent_score = await self.simulate_intent_analysis(frame)
            frame.processing_status = "completed"
            
            logger.info(f"Frame {frame.frame_id} processed - Intent: {frame.intent_score:.3f}")
            return frame
            
        except Exception as e:
            logger.error(f"Frame processing error: {e}")
            frame.processing_status = "error"
            return frame
    
    async def simulate_intent_analysis(self, frame: Frame) -> float:
        """Simulate AI intent analysis (replace with real CV APIs)"""
        # Basic simulation based on events and frame metadata
        intent_score = 0.0
        
        # Analyze user events in this frame
        for event in frame.events:
            if event['type'] == 'click':
                target = event['data'].get('target', '')
                if any(keyword in target.lower() for keyword in ['cart', 'buy', 'purchase']):
                    intent_score += 0.4
                elif any(keyword in target.lower() for keyword in ['price', 'product']):
                    intent_score += 0.2
            
            elif event['type'] == 'mouse_move':
                # Simulate mouse hover analysis
                intent_score += 0.05
        
        # URL-based signals
        if any(keyword in frame.url.lower() for keyword in ['checkout', 'cart', 'payment']):
            intent_score += 0.3
        elif any(keyword in frame.url.lower() for keyword in ['product', 'item']):
            intent_score += 0.1
        
        # Add some randomness to simulate real AI variability
        intent_score += np.random.normal(0, 0.1)
        return max(0.0, min(1.0, intent_score))

class IntentAnalyzer:
    """Analyzes time series of frames for behavioral patterns"""
    
    def __init__(self):
        self.state_thresholds = {
            'hot_buyer': 0.8,
            'considering': 0.6,
            'hesitating': 0.4,
            'losing_interest': 0.2,
            'browsing': 0.0
        }
    
    def analyze_session_intent(self, session: Session) -> Dict:
        """Analyze entire session for current intent state"""
        if len(session.frame_history) < 5:
            return {
                'current_state': 'browsing',
                'confidence': 0.3,
                'intent_trend': 0.0,
                'should_trigger_discount': False
            }
        
        # Get recent frame intent scores
        recent_frames = list(session.frame_history)[-20:]  # Last 4 seconds at 5fps
        intent_scores = [frame.intent_score for frame in recent_frames]
        
        # Calculate metrics
        current_intent = np.mean(intent_scores[-5:])  # Last 1 second
        previous_intent = np.mean(intent_scores[-10:-5]) if len(intent_scores) >= 10 else current_intent
        intent_trend = current_intent - previous_intent
        
        # Determine state
        current_state = self.classify_intent_state(current_intent, intent_trend)
        confidence = min(len(intent_scores) / 20, 1.0)  # More data = higher confidence
        
        # Discount trigger logic
        should_trigger = self.should_trigger_discount(
            current_state, current_intent, intent_trend, confidence, session
        )
        
        return {
            'current_state': current_state,
            'confidence': confidence,
            'intent_score': current_intent,
            'intent_trend': intent_trend,
            'should_trigger_discount': should_trigger,
            'session_duration': time.time() - session.start_time
        }
    
    def classify_intent_state(self, intent_score: float, trend: float) -> str:
        """Classify current intent state"""
        if intent_score > 0.8:
            return 'hot_buyer'
        elif intent_score > 0.6:
            return 'considering' if trend >= 0 else 'hesitating'
        elif intent_score > 0.4:
            return 'hesitating'
        elif intent_score > 0.2:
            return 'losing_interest' if trend < -0.1 else 'browsing'
        else:
            return 'browsing'
    
    def should_trigger_discount(self, state: str, intent: float, trend: float, 
                               confidence: float, session: Session) -> Dict:
        """Determine if discount should be triggered"""
        
        # Check cooldown (don't spam discounts)
        last_trigger_time = 0
        if session.discount_triggers:
            last_trigger_time = session.discount_triggers[-1]['timestamp']
        
        if time.time() - last_trigger_time < 30:  # 30-second cooldown
            return {'should_trigger': False, 'reason': 'cooldown_active'}
        
        # State-based discount logic
        trigger_rules = {
            'losing_interest': {
                'condition': intent > 0.3 and trend < -0.2 and confidence > 0.6,
                'discount': 20,
                'reason': 'Retention - user losing interest'
            },
            'hesitating': {
                'condition': intent > 0.5 and confidence > 0.7,
                'discount': 15,
                'reason': 'Conversion boost - user hesitating'
            },
            'considering': {
                'condition': intent > 0.7 and trend < -0.1,
                'discount': 10,
                'reason': 'Gentle nudge - prevent drop-off'
            }
        }
        
        rule = trigger_rules.get(state)
        if rule and rule['condition']:
            return {
                'should_trigger': True,
                'discount_percentage': rule['discount'],
                'reason': rule['reason'],
                'confidence': confidence
            }
        
        return {'should_trigger': False, 'reason': 'no_trigger_conditions_met'}

class DiscountingAIServer:
    """Main WebSocket server for real-time frame processing"""
    
    def __init__(self, host="localhost", port=8765):
        self.host = host
        self.port = port
        self.active_connections: Dict[str, websockets.WebSocketServerProtocol] = {}
        self.sessions: Dict[str, Session] = {}
        self.frame_processor = FrameProcessor()
        self.intent_analyzer = IntentAnalyzer()
        
        # Background task queues
        self.processing_queue = asyncio.Queue()
        self.notification_queue = asyncio.Queue()
        
        # Redis for session storage (optional)
        self.redis = None
        
        # Database for analytics (optional)
        self.db = None
    
    async def start_server(self):
        """Start the WebSocket server"""
        logger.info(f"Starting Discounting AI server on {self.host}:{self.port}")
        
        # Start background workers
        asyncio.create_task(self.frame_processing_worker())
        asyncio.create_task(self.notification_worker())
        asyncio.create_task(self.cleanup_worker())
        
        # Start WebSocket server
        async with websockets.serve(self.handle_connection, self.host, self.port):
            logger.info("Server started successfully")
            await asyncio.Future()  # Run forever
    
    async def handle_connection(self, websocket, path):
        """Handle new WebSocket connection"""
        connection_id = str(uuid.uuid4())
        self.active_connections[connection_id] = websocket
        
        logger.info(f"New connection: {connection_id}")
        
        try:
            await self.send_message(websocket, {
                'type': 'connection_established',
                'connection_id': connection_id,
                'timestamp': time.time()
            })
            
            async for message in websocket:
                await self.handle_message(websocket, message, connection_id)
                
        except websockets.exceptions.ConnectionClosed:
            logger.info(f"Connection closed: {connection_id}")
        except Exception as e:
            logger.error(f"Connection error: {e}")
        finally:
            # Cleanup
            if connection_id in self.active_connections:
                del self.active_connections[connection_id]
    
    async def handle_message(self, websocket, message: str, connection_id: str):
        """Handle incoming messages from clients"""
        try:
            data = json.loads(message)
            message_type = data.get('type')
            
            if message_type == 'init_session':
                await self.handle_session_init(websocket, data, connection_id)
            
            elif message_type == 'frame_data':
                await self.handle_frame_data(websocket, data, connection_id)
            
            elif message_type == 'heartbeat':
                await self.handle_heartbeat(websocket, data, connection_id)
            
            else:
                logger.warning(f"Unknown message type: {message_type}")
                
        except json.JSONDecodeError:
            logger.error("Invalid JSON received")
        except Exception as e:
            logger.error(f"Message handling error: {e}")
    
    async def handle_session_init(self, websocket, data: Dict, connection_id: str):
        """Initialize new session"""
        session_id = data.get('session_id')
        if not session_id:
            await self.send_error(websocket, "session_id required")
            return
        
        # Create new session
        session = Session(
            session_id=session_id,
            user_id=data.get('user_id'),
            website_domain=data.get('domain', 'unknown'),
            start_time=time.time(),
            last_activity=time.time()
        )
        
        self.sessions[session_id] = session
        
        logger.info(f"Session initialized: {session_id}")
        
        await self.send_message(websocket, {
            'type': 'session_initialized',
            'session_id': session_id,
            'timestamp': time.time()
        })
    
    async def handle_frame_data(self, websocket, data: Dict, connection_id: str):
        """Handle incoming frame data"""
        session_id = data.get('session_id')
        if not session_id or session_id not in self.sessions:
            await self.send_error(websocket, "Invalid session")
            return
        
        session = self.sessions[session_id]
        session.last_activity = time.time()
        
        # Create frame object
        frame = Frame(
            session_id=session_id,
            frame_id=data.get('frame_id', 0),
            timestamp=data.get('timestamp', time.time()),
            data=data.get('frame_data', ''),
            viewport=data.get('viewport', {}),
            url=data.get('url', ''),
            events=data.get('events', [])
        )
        
        # Add to processing queue
        await self.processing_queue.put((frame, websocket))
        
        session.frame_count += 1
        logger.debug(f"Frame queued for processing: {session_id}/{frame.frame_id}")
    
    async def handle_heartbeat(self, websocket, data: Dict, connection_id: str):
        """Handle heartbeat messages"""
        session_id = data.get('session_id')
        if session_id in self.sessions:
            self.sessions[session_id].last_activity = time.time()
        
        await self.send_message(websocket, {
            'type': 'heartbeat_ack',
            'timestamp': time.time()
        })
    
    async def frame_processing_worker(self):
        """Background worker for processing frames"""
        while True:
            try:
                frame, websocket = await self.processing_queue.get()
                
                # Process frame through AI pipeline
                processed_frame = await self.frame_processor.process_frame(frame)
                
                # Add to session history
                session = self.sessions.get(processed_frame.session_id)
                if session:
                    session.frame_history.append(processed_frame)
                    
                    # Analyze intent and check for discount triggers
                    intent_analysis = self.intent_analyzer.analyze_session_intent(session)
                    
                    # Update session state
                    session.current_state = intent_analysis['current_state']
                    
                    # Check for discount trigger
                    if intent_analysis['should_trigger_discount']['should_trigger']:
                        await self.trigger_discount(session, websocket, intent_analysis)
                    
                    # Send real-time analytics back to frontend
                    await self.send_message(websocket, {
                        'type': 'intent_update',
                        'session_id': session.session_id,
                        'intent_score': intent_analysis['intent_score'],
                        'current_state': intent_analysis['current_state'],
                        'confidence': intent_analysis['confidence'],
                        'timestamp': time.time()
                    })
                
                self.processing_queue.task_done()
                
            except Exception as e:
                logger.error(f"Frame processing worker error: {e}")
    
    async def trigger_discount(self, session: Session, websocket, intent_analysis: Dict):
        """Trigger discount offer"""
        trigger_data = intent_analysis['should_trigger_discount']
        
        discount_trigger = DiscountTrigger(
            trigger_type=session.current_state,
            discount_percentage=trigger_data['discount_percentage'],
            confidence=trigger_data['confidence'],
            reasoning=trigger_data['reason'],
            timestamp=time.time(),
            session_id=session.session_id
        )
        
        # Add to session history
        session.discount_triggers.append(asdict(discount_trigger))
        
        # Send discount trigger to frontend
        await self.send_message(websocket, {
            'type': 'discount_trigger',
            'discount_percentage': discount_trigger.discount_percentage,
            'reasoning': discount_trigger.reasoning,
            'confidence': discount_trigger.confidence,
            'trigger_type': discount_trigger.trigger_type,
            'timestamp': discount_trigger.timestamp
        })
        
        logger.info(f"🎯 DISCOUNT TRIGGERED: {discount_trigger.discount_percentage}% for {session.session_id}")
        logger.info(f"   Reason: {discount_trigger.reasoning}")
    
    async def notification_worker(self):
        """Background worker for sending notifications"""
        # TODO: Implement notification system for alerts, analytics, etc.
        pass
    
    async def cleanup_worker(self):
        """Background worker for cleanup tasks"""
        while True:
            try:
                await asyncio.sleep(300)  # Run every 5 minutes
                
                current_time = time.time()
                expired_sessions = []
                
                # Find expired sessions (inactive for 30 minutes)
                for session_id, session in self.sessions.items():
                    if current_time - session.last_activity > 1800:
                        expired_sessions.append(session_id)
                
                # Remove expired sessions
                for session_id in expired_sessions:
                    del self.sessions[session_id]
                    logger.info(f"Cleaned up expired session: {session_id}")
                
            except Exception as e:
                logger.error(f"Cleanup worker error: {e}")
    
    async def send_message(self, websocket, message: Dict):
        """Send message to websocket client"""
        try:
            await websocket.send(json.dumps(message))
        except Exception as e:
            logger.error(f"Failed to send message: {e}")
    
    async def send_error(self, websocket, error_message: str):
        """Send error message to client"""
        await self.send_message(websocket, {
            'type': 'error',
            'message': error_message,
            'timestamp': time.time()
        })
    
    def get_stats(self) -> Dict:
        """Get server statistics"""
        return {
            'active_connections': len(self.active_connections),
            'active_sessions': len(self.sessions),
            'total_frames_processed': sum(s.frame_count for s in self.sessions.values()),
            'processing_queue_size': self.processing_queue.qsize(),
            'uptime': time.time()
        }

# Main server runner
async def main():
    server = DiscountingAIServer(host="0.0.0.0", port=8765)
    await server.start_server()

if __name__ == "__main__":
    print("🚀 Starting Discounting AI Backend Server")
    print("📡 WebSocket endpoint: ws://localhost:8765")
    print("🎯 Ready for real-time frame streaming...")
    
    asyncio.run(main())