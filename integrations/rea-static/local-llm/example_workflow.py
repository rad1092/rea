"""Staged example; nothing runs on import. It never calls a model or HTTP API."""
from rea_connector import ReaConfig, ReaSession, summary_messages


async def inspect_selected_directory(config_file, relative_input_path, question):
    config = ReaConfig.load(config_file)
    async with ReaSession(config) as session:
        receipt = await session.call('rea_analyze', {'input_path': relative_input_path},
                                     owner_session_id=session.session_id)
        # A host integration keeps this context open for same-session discovery,
        # calls, and paging before closing. This one-shot example has no follow-ups.
        return summary_messages(question, receipt)
