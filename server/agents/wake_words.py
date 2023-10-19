explicit_wake_words = [
    "hey convoscope",
    "hey conboscope",
    "hey confoscope",
    "hey condoscope",

    "hey comvoscope"
    "hey comboscope",
    "hey comfoscope",
    "hey comdoscope",

    "hey convo scope",
]

def does_text_contain_wake_word(transcript):
    transcript_low = transcript.lower()
    for term in explicit_wake_words:
        if term in transcript_low:
            return True
    return False

def get_explicit_query_from_transcript(transcript):
    transcript_low = transcript.lower()
    for term in explicit_wake_words:
        if term in transcript_low:
            index = transcript_low.find(term) + len(term)
            return transcript_low[index:]
    return None